const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
    destroy: async () => { capture.loggingDestroyed = true; },
    logger,
  });
  setCachedModule(otelPath, {
    initObservability: async (config) => {
      if (failures.telemetry) throw failures.telemetry;
      capture.telemetry = config;
      return {
        tracer,
        metrics,
        forceFlush: async () => {},
        shutdown: async () => {},
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
    enableTracing: false,
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
    enabled: false,
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
    ENABLE_TRACING: 'false',
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
  const installedSdk = require('elven-opentelemetry-instrumentation-js/package.json');
  const state = require('../candidate-state.json');

  assert.equal(manifest.version, state.version);
  assert.equal(installedSdk.version, state.requiredInstrumentationVersion);
  assert.equal(manifest.dependencies['@opentelemetry/api'], '1.9.1');
  assert.equal(manifest.dependencies['elven-logs-interceptor'], '1.1.0');
  const sdkDependency = manifest.dependencies['elven-opentelemetry-instrumentation-js'];
  assert.ok(sdkDependency === installedSdk.version || sdkDependency === 'file:vendor/instrumentation-sdk.tgz');
  const lockPath = path.join(packageRoot, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.packages[''].name, manifest.name);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
    assert.equal(lock.packages['node_modules/elven-opentelemetry-instrumentation-js'].version, installedSdk.version);
  } else {
    assert.equal(state.publicLockStatus, 'blocked-until-instrumentation-version-is-published');
    const bytes = fs.readFileSync(path.join(packageRoot, state.archivedLock));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), state.archivedLockSHA256);
    assert.equal(state.promotionEligible, false);
  }
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.sideEffects.includes('./dist/register.js'), true);
  assert.equal(manifest.repository.url, 'git+https://github.com/elven-observability/elven-unified-observability-js.git');
  assert.equal(manifest.license, 'ISC');
  assert.ok(fs.readFileSync(path.join(packageRoot, 'LICENSE'), 'utf8').includes('ISC License'));
});
