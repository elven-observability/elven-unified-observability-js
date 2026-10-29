const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { gunzipSync } = require('node:zlib');
const protobuf = require('protobufjs');
const schema = new protobuf.Root();
schema.resolvePath = (_origin, target) => path.join(__dirname, 'protos', target);
schema.loadSync(['trace', 'logs', 'metrics'].map(signal =>
  `opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`));
const requests = Object.fromEntries(['trace', 'logs', 'metrics'].map(signal => [
  signal, schema.lookupType(`opentelemetry.proto.collector.${signal}.v1.Export${signal[0].toUpperCase() + signal.slice(1)}ServiceRequest`),
]));
function decode(record) {
  const signal = record.path.endsWith('/traces') ? 'trace' : record.path.endsWith('/logs') ? 'logs' : 'metrics';
  return requests[signal].decode(record.bytes);
}

test('exports correlated logs, traces, and metrics without application credentials', { timeout: 20_000 }, async () => {
  const paths = [];
  const captured = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      const bytes = Buffer.concat(chunks);
      captured.push({ path: req.url, headers: req.headers, bytes: req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes });
      res.writeHead(req.url === '/logs' ? 204 : 200, {
        'content-type': 'application/x-protobuf',
      });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let handle;
  let activeSpanContext;
  try {
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}`;
    const { init } = require('../dist/index.js');
    handle = await init({
      serviceName: 'unified-integration-test',
      enableLogging: true,
      enableTracing: true,
      enableMetrics: true,
      failOpen: false,
      exportMode: 'collector',
      collector: { endpoint: `${endpoint}/otel` },
      logging: {
        transport: {
          url: `${endpoint}/ignored-by-collector-mode`,
          authToken: 'obsolete-log-token-must-not-forward',
          tenantId: 'obsolete-tenant-must-not-forward',
          compression: 'none',
          maxRetries: 0,
          timeout: 2_000,
        },
        buffer: { maxSize: 1, flushInterval: 60_000 },
        deadLetterQueue: { enabled: false },
        performance: { useWorkers: false, maxPendingBatches: 1 },
      },
      telemetry: {
        autoShutdown: false,
        tracing: { enabled: true, sampling: { ratio: 1 } },
        metrics: { enabled: true, exportIntervalMillis: 60_000 },
        instrumentations: false,
      },
    });

    await handle.tracer.withSpan('integration-span', async () => {
      activeSpanContext = require('@opentelemetry/api').trace.getActiveSpan()?.spanContext();
      handle.logger.info('integration-test');
    });
    handle.metrics.increment('integration_counter');
    await handle.forceFlush();
    await handle.shutdown();
  } finally {
    if (handle) await handle.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(paths.includes('/otel/v1/logs'), true);
  assert.equal(paths.includes('/otel/v1/traces'), true);
  assert.equal(paths.includes('/otel/v1/metrics'), true);
  assert.ok(activeSpanContext?.traceId && activeSpanContext?.spanId);
  for (const record of captured) {
    assert.equal(record.headers.authorization, undefined);
    assert.equal(record.headers['x-scope-orgid'], undefined);
    assert.equal(record.headers['x-api-key'], undefined);
    assert.match(record.headers['content-type'], /application\/(x-)?protobuf/);
    assert.ok(record.bytes.length > 0);
    const message = decode(record);
    const resources = message.resourceSpans || message.resourceLogs || message.resourceMetrics;
    assert.deepEqual(resources.map(resource =>
      resource.resource.attributes.find(attr => attr.key === 'service.name').value.stringValue),
      ['unified-integration-test']);
  }
  const spans = captured.filter(record => record.path.endsWith('/v1/traces'))
    .flatMap(record => decode(record).resourceSpans.flatMap(resource =>
      resource.scopeSpans.flatMap(scope => scope.spans)));
  const span = spans.find(record => record.name === 'integration-span');
  assert.ok(span, 'actual OTLP payload must contain the emitted span');
  assert.equal(span.traceId.toString('hex'), activeSpanContext.traceId);
  assert.equal(span.spanId.toString('hex'), activeSpanContext.spanId);
  const logs = captured.filter(record => record.path.endsWith('/v1/logs'))
    .flatMap(record => decode(record).resourceLogs.flatMap(resource =>
      resource.scopeLogs.flatMap(scope => scope.logRecords)));
  assert.ok(logs.some(record => record.traceId.toString('hex') === activeSpanContext.traceId
    && record.spanId.toString('hex') === activeSpanContext.spanId), 'OTLP log must carry real active IDs');
  const metrics = captured.filter(record => record.path.endsWith('/v1/metrics'))
    .flatMap(record => decode(record).resourceMetrics.flatMap(resource =>
      resource.scopeMetrics.flatMap(scope => scope.metrics)));
  assert.ok(metrics.some(record => record.name === 'integration_counter'));
});

test('signal cleanup preserves the application exit code', async () => {
  const packageRoot = path.resolve(__dirname, '..');
  const source = [
    'const unified = require("./dist/index.js");',
    '(async () => {',
    '  await unified.init({',
    '    serviceName: "signal-test",',
    '    enableLogging: false,',
    '    enableTracing: false,',
    '    enableMetrics: false,',
    '    telemetry: { autoShutdown: true }',
    '  });',
    '  process.exitCode = 31;',
    '  process.emit("SIGTERM");',
    '  setTimeout(() => console.log("unified-signal-cleanup-complete"), 25);',
    '})().catch((error) => { console.error(error); process.exitCode = 99; });',
  ].join(' ');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 31);
  assert.match(result.stdout, /unified-signal-cleanup-complete/);
  assert.equal(result.stderr, '');
});

test('signal cleanup preserves default SIGTERM lifecycle', async () => {
  const packageRoot = path.resolve(__dirname, '..');
  const source = [
    'const unified = require("./dist/index.js");',
    '(async () => {',
    '  await unified.init({',
    '    serviceName: "real-signal-test",',
    '    enableLogging: false,',
    '    enableTracing: false,',
    '    enableMetrics: false,',
    '    telemetry: { autoShutdown: true }',
    '  });',
    '  console.log("ready");',
    '  setInterval(() => {}, 1000);',
    '})().catch((error) => { console.error(error); process.exitCode = 99; });',
  ].join(' ');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not preserve SIGTERM lifecycle'));
    }, 5_000);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) child.kill('SIGTERM');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });

  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.stderr, '');
});

test('fail-open telemetry configuration failure leaves callable manual facades', { timeout: 10_000 }, async () => {
  const packageRoot = path.resolve(__dirname, '..');
  const source = `
    const assert = require('node:assert/strict');
    const unified = require('./dist/index.js');
    (async () => {
      const handle = await unified.init({
        serviceName: 'fail-open-facades', exportMode: 'collector',
        collector: { endpoint: '' }, enableLogging: false, failOpen: true,
        telemetry: { autoShutdown: false },
      });
      assert.equal(handle.getStatus().healthy, false);
      assert.equal(handle.getStatus().components.tracing, 'degraded');
      assert.equal(handle.getStatus().components.metrics, 'degraded');
      assert.equal(await handle.tracer.withSpan('application-work', () => 42), 42);
      handle.metrics.increment('application_work');
      await handle.forceFlush();
      await handle.shutdown();
      assert.equal(handle.isStarted(), false);
      console.log('fail-open-facades-passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fail-open child did not exit')); }, 8_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fail-open-facades-passed/);
  assert.match(result.stderr, /Collector mode requires an endpoint for traces/);
});
