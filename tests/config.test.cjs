const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const semver = require('semver');
const { afterEach, test } = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const indexPath = path.join(packageRoot, 'dist', 'index.js');
const registerPath = path.join(packageRoot, 'dist', 'register.js');
const logsPath = require.resolve('elven-logs-interceptor', { paths: [packageRoot] });
const otelPath = require.resolve('elven-opentelemetry-instrumentation-js', { paths: [packageRoot] });
const originalEnv = process.env;
const originalLogsCache = require.cache[logsPath];
const originalOtelCache = require.cache[otelPath];

function setCachedModule(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

function loadIndexWithFakes(capture, failures = {}) {
  const logger = {
    info() {}, warn() {}, error() {}, debug() {}, fatal() {}, log() {},
    flush: async () => {},
    destroy: async () => {},
    getHealth: () => ({ healthy: true }),
  };
  const tracer = {};
  const metrics = {};
  setCachedModule(logsPath, {
    init: (config) => {
      if (failures.logging) throw failures.logging;
      capture.logging = config;
      return logger;
    },
    destroy: async () => { capture.loggingDestroyed = true; return failures.loggerShutdownPromise; },
    logger,
  });
  setCachedModule(otelPath, {
    initObservability: async (config) => {
      if (failures.telemetry) throw failures.telemetry;
      capture.telemetry = config;
      if (failures.telemetryPromise) return failures.telemetryPromise;
      return {
        tracer,
        metrics,
        forceFlush: async () => { capture.telemetryFlushed = true; return failures.flushPromise; },
        shutdown: async () => { capture.telemetryShutdown = true; return failures.shutdownPromise; },
      };
    },
    MetricFacade: class MetricFacade {},
    TracerFacade: class TracerFacade {},
    tracer,
    metrics,
  });
  delete require.cache[indexPath];
  return require(indexPath);
}

afterEach(() => {
  process.env = originalEnv;
  delete require.cache[indexPath];
  delete require.cache[registerPath];
  if (originalLogsCache) require.cache[logsPath] = originalLogsCache;
  else delete require.cache[logsPath];
  if (originalOtelCache) require.cache[otelPath] = originalOtelCache;
  else delete require.cache[otelPath];
});

test('passes structured telemetry config and master switches always win', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture);

  await unified.init({
    serviceName: 'test-service',
    enableLogging: false,
    enableTracing: true,
    enableMetrics: false,
    telemetry: {
      tracing: { enabled: true, sampling: { ratio: 0.25 } },
      metrics: { enabled: true, cardinalityLimit: 100 },
      instrumentations: { http: true, fs: false },
      autoShutdown: false,
    },
  });

  assert.equal(capture.logging, undefined);
  assert.deepEqual(capture.telemetry.tracing, {
    enabled: true,
    sampling: { ratio: 0.25 },
  });
  assert.deepEqual(capture.telemetry.metrics, {
    enabled: false,
    cardinalityLimit: 100,
  });
  assert.deepEqual(capture.telemetry.instrumentations, {
    http: { enabled: true },
    fs: { enabled: false },
  });
  assert.equal(capture.telemetry.autoShutdown, false);
});

test('register applies bounded defaults and ignores invalid numeric env values', async () => {
  process.env = {
    ...originalEnv,
    ENABLE_LOGGING: 'false',
    ENABLE_TRACING: 'true',
    ENABLE_METRICS: 'false',
    OTEL_TRACES_SAMPLING_RATIO: 'invalid',
    OTEL_METRIC_EXPORT_INTERVAL: 'invalid',
    OTEL_METRIC_EXPORT_TIMEOUT: 'invalid',
    OTEL_METRICS_CARDINALITY_LIMIT: 'invalid',
    OTEL_METRIC_EXPORT_BATCH_SIZE: 'invalid',
    LOGS_MAX_PENDING_BATCHES: 'invalid',
    LOGS_DEBUG: 'false',
  };

  let captured;
  setCachedModule(indexPath, {
    init: async (config) => { captured = config; },
  });
  delete require.cache[registerPath];
  require(registerPath);
  await Promise.resolve();

  assert.equal(captured.enableLogging, false);
  assert.equal(captured.telemetry.tracing.sampling.ratio, 0.1);
  assert.equal(captured.telemetry.metrics.exportIntervalMillis, 60_000);
  assert.equal(captured.telemetry.metrics.exportTimeoutMillis, 10_000);
  assert.equal(captured.telemetry.metrics.cardinalityLimit, 200);
  assert.equal(captured.telemetry.metrics.maxExportBatchSize, 256);
  assert.equal(captured.logging.buffer.maxMemoryMB, 32);
  assert.equal(captured.logging.performance.maxPendingBatches, 2);
  assert.equal(captured.logging.deadLetterQueue.type, 'memory');
  assert.equal(captured.logging.deadLetterQueue.maxSize, 100);
});

test('collector mode routes every signal through one OTLP base endpoint', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture);

  await unified.init({
    serviceName: 'collector-service',
    exportMode: 'collector',
    collector: { endpoint: 'http://collector:4318' },
    logging: { transport: { url: 'https://obsolete.invalid', tenantId: 'old-tenant', authToken: 'old-token' } },
    telemetry: { autoShutdown: false, instrumentations: false },
  });

  assert.equal(capture.logging.transport.type, 'otlp');
  assert.equal(capture.logging.transport.url, 'http://collector:4318');
  assert.equal(capture.logging.transport.tenantId, undefined);
  assert.equal(capture.logging.transport.authToken, undefined);
  assert.equal(capture.telemetry.exporters.url, 'http://collector:4318');
  assert.equal(capture.telemetry.exporters.protocol, 'http/protobuf');
});

test('register enables credential-free OTLP logs in collector mode', async () => {
  process.env = {
    ...originalEnv,
    ELVEN_EXPORTER_MODE: 'collector',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector:4318/v1/logs',
    LOGS_TOKEN: 'must-not-be-forwarded',
    LOGS_DEBUG: 'false',
  };

  let captured;
  setCachedModule(indexPath, {
    init: async (config) => { captured = config; },
  });
  delete require.cache[registerPath];
  require(registerPath);
  await Promise.resolve();

  assert.equal(captured.exportMode, 'collector');
  assert.equal(captured.collector.endpoint, 'http://collector:4318');
  assert.equal(captured.logging.transport.type, 'otlp');
  assert.equal(captured.logging.transport.url, 'http://collector:4318/v1/logs');
  assert.equal(captured.logging.transport.authToken, undefined);
  assert.equal(captured.logging.transport.tenantId, undefined);
});

test('reports partial fail-open initialization without hiding component errors', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture, {
    logging: new Error('logger unavailable'),
  });

  const handle = await unified.init({
    serviceName: 'partial-service',
    enableLogging: true,
    enableTracing: true,
    enableMetrics: true,
    failOpen: true,
    telemetry: { autoShutdown: false, instrumentations: false },
  });

  assert.equal(handle.isStarted(), true);
  assert.deepEqual(handle.getStatus().components, {
    logging: 'degraded',
    tracing: 'ready',
    metrics: 'ready',
  });
  assert.equal(handle.getStatus().healthy, false);
  assert.equal(handle.getStatus().partial, true);
  assert.deepEqual(handle.getStatus().errors, [{
    component: 'logging',
    message: 'logger unavailable',
  }]);
});

test('a logs-only endpoint never becomes the base for traces and metrics', async () => {
  process.env = {
    ...originalEnv,
    ELVEN_EXPORTER_MODE: 'collector',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector:4318/v1/logs',
    LOGS_DEBUG: 'false',
  };
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  let captured;
  setCachedModule(indexPath, { init: async (config) => { captured = config; } });
  delete require.cache[registerPath];
  require(registerPath);
  await Promise.resolve();
  assert.equal(captured.collector.endpoint, '');
  assert.equal(captured.collector.logsEndpoint, 'http://collector:4318/v1/logs');
  assert.equal(captured.collector.tracesEndpoint, undefined);
});

test('collector mode rejects missing trace endpoint instead of exporting to a log URL', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture);
  await assert.rejects(unified.init({
    serviceName: 'incomplete-collector', exportMode: 'collector', failOpen: false,
    collector: { endpoint: '', logsEndpoint: 'http://collector:4318/v1/logs' },
    telemetry: { autoShutdown: false },
  }), /Collector mode requires an endpoint for traces/);
  assert.equal(capture.telemetry, undefined);
  assert.equal(capture.loggingDestroyed, true);
});

test('strict initialization cleans up and rejects component failures', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture, {
    telemetry: new Error('telemetry unavailable'),
  });

  await assert.rejects(unified.init({
    serviceName: 'strict-service',
    enableLogging: true,
    enableTracing: true,
    enableMetrics: true,
    failOpen: false,
    logging: {
      transport: { url: 'https://logs.example.test/push', tenantId: 'tenant' },
    },
    telemetry: { autoShutdown: false },
  }), /telemetry: telemetry unavailable/);

  assert.equal(capture.loggingDestroyed, true);
  assert.equal(unified.isInitialized(), false);
  assert.equal(unified.getStatus().state, 'idle');
  assert.equal(unified.getStatus().healthy, false);
});

test('register never injects a production endpoint or tenant default', async () => {
  process.env = {
    ...originalEnv,
    ELVEN_EXPORTER_MODE: 'direct',
    LOGS_DEBUG: 'false',
  };
  delete process.env.LOGS_URL;
  delete process.env.LOKI_URL;
  delete process.env.LOGS_TENANT;
  delete process.env.LOKI_TENANT;

  let captured;
  setCachedModule(indexPath, {
    init: async (config) => { captured = config; },
  });
  delete require.cache[registerPath];
  require(registerPath);
  await Promise.resolve();

  assert.equal(captured.logging.transport.url, '');
  assert.equal(captured.logging.transport.tenantId, undefined);
});

test('package metadata and lockfile are coherent', () => {
  const manifest = require('../package.json');
  const lockPath = path.join(packageRoot, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  const statePath = path.join(packageRoot, 'candidate-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  for (const [name, range] of Object.entries(state?.publicDependencies || manifest.dependencies)) {
    assert.ok(semver.satisfies(lock.packages[`node_modules/${name}`].version, range));
    assert.equal(semver.prerelease(lock.packages[`node_modules/${name}`].version), null);
  }
  const verify = require('../scripts/verify-public-lock.cjs').verify;
  if (state?.publicLockStatus === 'candidate-local-only') {
    assert.equal(manifest.private, true);
    assert.throws(() => verify(), /Publication blocked/);
  } else {
    assert.equal(verify().status, 'verified-public-registry');
  }
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.sideEffects.includes('./dist/register.js'), true);
  assert.equal(manifest.repository.url, 'git+https://github.com/elven-observability/elven-unified-observability-js.git');
  assert.equal(manifest.license, 'ISC');
  assert.ok(fs.readFileSync(path.join(packageRoot, 'LICENSE'), 'utf8').includes('ISC License'));
});

test('all disabled signals avoid SDK initialization and signal hooks', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture);
  const counts = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
  const handle = await unified.init({ serviceName: 'disabled', enableLogging: false,
    enableTracing: false, enableMetrics: false });
  assert.equal(unified.tracer, handle.tracer);
  assert.equal(unified.metrics, handle.metrics);
  assert.equal(capture.telemetry, undefined);
  assert.deepEqual(handle.getStatus().components, { logging: 'disabled', tracing: 'disabled', metrics: 'disabled' });
  await handle.forceFlush();
  await handle.shutdown();
  assert.equal(capture.loggingDestroyed, undefined);
  assert.deepEqual(['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal)), counts);
});

test('shutdown removes only its own hooks over repeated initialization', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture);
  const applicationHandler = () => {};
  process.on('SIGTERM', applicationHandler);
  const counts = ['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal));
  try {
    for (let index = 0; index < 20; index += 1) {
      await unified.init({ serviceName: 'cycles', enableLogging: false, enableMetrics: false });
      assert.equal(process.listenerCount('SIGTERM'), counts[0] + 1);
      await unified.shutdown();
      assert.deepEqual(['SIGTERM', 'SIGINT'].map(signal => process.listenerCount(signal)), counts);
    }
    assert.ok(process.listeners('SIGTERM').includes(applicationHandler));
  } finally { process.removeListener('SIGTERM', applicationHandler); }
});

test('flush and shutdown deadlines bound waits without claiming cancellation', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const capture = {};
  const unified = loadIndexWithFakes(capture, { flushPromise: pending, shutdownPromise: pending });
  await unified.init({ serviceName: 'deadline', enableLogging: false,
    shutdownTimeoutMillis: 10, telemetry: { autoShutdown: false } });
  await assert.rejects(unified.forceFlush(), /exceeded 10 ms/);
  await assert.rejects(unified.shutdown(), /exceeded 10 ms/);
  assert.equal(unified.getStatus().state, 'stopping');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unified.getStatus().state, 'idle');
});

test('late initialization is cleaned up after a fail-open deadline', async () => {
  let finish;
  let stopped = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const capture = {};
  const unified = loadIndexWithFakes(capture, { telemetryPromise: pending });
  const handle = await unified.init({ serviceName: 'late-init', enableLogging: false,
    initializationTimeoutMillis: 10, telemetry: { autoShutdown: false } });
  assert.equal(handle.getStatus().healthy, false);
  finish({ shutdown: async () => { stopped += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  await handle.shutdown();
});

test('abandoned startup fences replacement initialization until late cleanup settles', async () => {
  let finish;
  let stopped = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const capture = {};
  const unified = loadIndexWithFakes(capture, { telemetryPromise: pending });
  await unified.init({ serviceName: 'old-owner', enableLogging: false,
    initializationTimeoutMillis: 10, shutdownTimeoutMillis: 10, telemetry: { autoShutdown: false } });
  await assert.rejects(unified.shutdown(), /exceeded 10 ms/);
  assert.equal(unified.getStatus().state, 'stopping');
  await assert.rejects(unified.init({ serviceName: 'new-owner', enableLogging: false }), /previous shutdown/);
  assert.equal(capture.telemetry.service.serviceName, 'old-owner');
  finish({ shutdown: async () => { stopped += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(unified.getStatus().state, 'idle');
});

test('active signal cleanup preserves an application once handler and exit code', async () => {
  const originalExitCode = process.exitCode;
  const originalKill = process.kill;
  let applicationCalls = 0;
  const kills = [];
  const applicationHandler = () => { applicationCalls += 1; process.exitCode = 17; };
  process.once('SIGTERM', applicationHandler);
  process.kill = (...args) => { kills.push(args); return true; };
  const capture = {};
  const unified = loadIndexWithFakes(capture);
  try {
    await unified.init({ serviceName: 'signal-owner', enableLogging: false });
    process.emit('SIGTERM');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(applicationCalls, 1);
    assert.equal(process.exitCode, 17);
    assert.equal(capture.telemetryShutdown, true);
    assert.deepEqual(kills, []);
  } finally {
    await unified.shutdown();
    process.removeListener('SIGTERM', applicationHandler);
    process.exitCode = originalExitCode;
    process.kill = originalKill;
  }
});

test('component diagnostics redact credentials and tolerate unreadable errors', async () => {
  const capture = {};
  const unified = loadIndexWithFakes(capture, { telemetry: new Error('token=synthetic-secret https://user:password@example.test/private?secret=value') });
  const handle = await unified.init({ serviceName: 'diagnostics', enableLogging: false,
    telemetry: { autoShutdown: false } });
  const diagnostic = handle.getStatus().errors[0].message;
  assert.doesNotMatch(diagnostic, /synthetic-secret|password|secret=value/);
  await handle.shutdown();
  const unreadable = { toString() { throw new Error('unreadable'); } };
  const next = loadIndexWithFakes({}, { telemetry: unreadable });
  const second = await next.init({ serviceName: 'unreadable', enableLogging: false,
    telemetry: { autoShutdown: false } });
  assert.match(second.getStatus().errors[0].message, /unreadable error/);
  await second.shutdown();
});
