
// Helper to safely parse numbers
const getIntEnv = (key: string, defaultVal: number): number => {
  const val = process.env[key];
  if (val === undefined || val.trim() === '') return defaultVal;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : defaultVal;
};

const getFloatEnv = (key: string, defaultVal: number): number => {
  const val = process.env[key];
  if (val === undefined || val.trim() === '') return defaultVal;
  const parsed = Number.parseFloat(val);
  return Number.isFinite(parsed) ? parsed : defaultVal;
};

// Helper for boolean
const getBoolEnv = (key: string, defaultVal: boolean): boolean => {
  const val = process.env[key];
  if (val === undefined) return defaultVal;
  return val.toLowerCase() === 'true' || val === '1';
};

// Helper to check LOGS_ key first, then LOKI_ key
const getEnv = (suffix: string, defaultVal?: string): string | undefined => {
  return process.env[`LOGS_${suffix}`] || process.env[`LOKI_${suffix}`] || defaultVal;
};

const getBoolEnvWithFallback = (suffix: string, defaultVal: boolean): boolean => {
  const logsKey = `LOGS_${suffix}`;
  if (process.env[logsKey] !== undefined) return getBoolEnv(logsKey, defaultVal);
  return getBoolEnv(`LOKI_${suffix}`, defaultVal);
};

const getIntEnvWithFallback = (suffix: string, defaultVal: number): number => {
  const logsVal = process.env[`LOGS_${suffix}`];
  if (logsVal !== undefined) return getIntEnv(`LOGS_${suffix}`, defaultVal);
  const lokiVal = process.env[`LOKI_${suffix}`];
  if (lokiVal !== undefined) return getIntEnv(`LOKI_${suffix}`, defaultVal);
  return defaultVal;
};

const getFloatEnvWithFallback = (suffix: string, defaultVal: number): number => {
  const logsVal = process.env[`LOGS_${suffix}`];
  if (logsVal !== undefined) return getFloatEnv(`LOGS_${suffix}`, defaultVal);
  return getFloatEnv(`LOKI_${suffix}`, defaultVal);
};

const getTracingSamplingRatio = (): number | undefined => {
  if (process.env.OTEL_TRACES_SAMPLER) return undefined;

  const raw =
    process.env.OTEL_TRACES_SAMPLING_RATIO ||
    process.env.OTEL_SAMPLING_RATIO ||
    process.env.TRACING_SAMPLING_RATIO;

  if (!raw) return 0.1;

  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) return 0.1;

  return Math.max(0, Math.min(1, parsed));
};

const getExportMode = (): 'direct' | 'collector' => {
  const configured = process.env.ELVEN_EXPORTER_MODE?.trim().toLowerCase();
  return configured === 'collector' || configured === 'otlp' ? 'collector' : 'direct';
};


// Auto-initialize based on Environment Variables
const bootstrap = async () => {
  try {
    const masterDisabled = !getBoolEnv('UO_ENABLED', true)
      || !getBoolEnv('ELVEN_OBSERVABILITY_ENABLED', true)
      || getBoolEnv('OTEL_SDK_DISABLED', false);
    if (masterDisabled || !['ENABLE_LOGGING', 'ENABLE_METRICS', 'ENABLE_TRACING']
      .some((key) => getBoolEnv(key, true))) return;
    // Load synchronously after the kill switch, before application frameworks.
    const { init } = require('./index') as typeof import('./index');
    // Debug: Check if envs are actually loaded
    if (process.env.LOGS_DEBUG === 'true' || process.env.LOKI_DEBUG === 'true') {
      console.log('[unified-observability] DEBUG Mode Enabled');
      console.log('[unified-observability] CWD:', process.cwd());
      console.log('[unified-observability] LOGS_COMPRESSION:', process.env.LOGS_COMPRESSION);
      console.log('[unified-observability] LOKI_COMPRESSION:', process.env.LOKI_COMPRESSION);
    }

    const serviceName = getEnv('APP_NAME') || process.env.OTEL_SERVICE_NAME || 'unknown-service';
    const version = getEnv('APP_VERSION') || process.env.OTEL_SERVICE_VERSION || '1.0.0';
    const environment = process.env.NODE_ENV || 'development';
    const exportMode = getExportMode();
    const collectorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const collectorLogsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;

    // Global Toggles
    const enableLogging = getBoolEnv('ENABLE_LOGGING', true);
    // LOGS_ENABLE_METRICS overrides general ENABLE_METRICS for the logger component specifically
    const enableMetrics = getBoolEnv('ENABLE_METRICS', getBoolEnvWithFallback('ENABLE_METRICS', true));
    const enableTracing = getBoolEnv('ENABLE_TRACING', true);

    const compression = (getEnv('COMPRESSION') as any) || 'gzip';
    const tracingSamplingRatio = getTracingSamplingRatio();

    // Logging Configuration Mapping
    const loggingConfig = {
      transport: {
        type: exportMode === 'collector' ? 'otlp' as const : 'loki' as const,
        url: exportMode === 'collector'
          ? collectorLogsEndpoint || collectorEndpoint || ''
          : getEnv('URL') || '',
        tenantId: exportMode === 'collector' ? undefined : getEnv('TENANT'),
        authToken: exportMode === 'collector' ? undefined : getEnv('TOKEN'),
        compression: compression,
        compressionLevel: getIntEnvWithFallback('COMPRESSION_LEVEL', 4),
        compressionThreshold: getIntEnvWithFallback('COMPRESSION_THRESHOLD', 4096),
        useWorkers: getBoolEnvWithFallback('USE_WORKERS', false),
        maxWorkers: getIntEnvWithFallback('MAX_WORKERS', 1),
        enableConnectionPooling: getBoolEnvWithFallback('CONNECTION_POOLING', true),
        maxSockets: getIntEnvWithFallback('MAX_SOCKETS', 10),
        timeout: getIntEnvWithFallback('TIMEOUT', 5000),
        maxRetries: getIntEnvWithFallback('MAX_RETRIES', 1),
        retryDelay: getIntEnvWithFallback('RETRY_DELAY', 1000),
      },
      labels: {
        service: getEnv('LABEL_SERVICE') || serviceName,
        environment: getEnv('LABEL_ENVIRONMENT') || environment,
        ...(getEnv('LABEL_REGION') && { region: getEnv('LABEL_REGION') }),
        ...(getEnv('LABEL_CLUSTER') && { cluster: getEnv('LABEL_CLUSTER') }),
      },
      buffer: {
        maxSize: getIntEnvWithFallback('BUFFER_MAX_SIZE', 250),
        flushInterval: getIntEnvWithFallback('BUFFER_FLUSH_INTERVAL', 2000),
        maxMemoryMB: getIntEnvWithFallback('BUFFER_MAX_MEMORY_MB', 32),
        maxAge: getIntEnvWithFallback('BUFFER_MAX_AGE', 30000),
        autoFlush: getBoolEnvWithFallback('BUFFER_AUTO_FLUSH', true),
      },
      filter: {
        levels: (getEnv('FILTER_LEVELS')?.split(',') as any[]) ||
          ['info', 'warn', 'error', 'fatal'],
        samplingRate: getFloatEnvWithFallback('FILTER_SAMPLING_RATE', 1.0),
        sanitize: getBoolEnvWithFallback('FILTER_SANITIZE', true),
        maxMessageLength: getIntEnvWithFallback('FILTER_MAX_MESSAGE_LENGTH', 2048),
        maxContextBytes: getIntEnvWithFallback('FILTER_MAX_CONTEXT_BYTES', 16384),
      },
      circuitBreaker: {
        enabled: getBoolEnvWithFallback('CIRCUIT_BREAKER_ENABLED', true),
        failureThreshold: getIntEnvWithFallback('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 50),
        resetTimeout: getIntEnvWithFallback('CIRCUIT_BREAKER_RESET_TIMEOUT', 30000),
        halfOpenRequests: getIntEnvWithFallback('CIRCUIT_BREAKER_HALF_OPEN_REQUESTS', 3),
      },
      deadLetterQueue: {
        enabled: getBoolEnvWithFallback('DLQ_ENABLED', true),
        type: (getEnv('DLQ_TYPE') as 'memory' | 'file') || 'memory',
        maxSize: getIntEnvWithFallback('DLQ_MAX_SIZE', 100),
        maxRetries: getIntEnvWithFallback('DLQ_MAX_RETRIES', 3),
        basePath: getEnv('DLQ_BASE_PATH') || './.logs-dlq',
      },
      performance: {
        useWorkers: getBoolEnvWithFallback('USE_WORKERS', false),
        maxConcurrentFlushes: getIntEnvWithFallback('MAX_CONCURRENT_FLUSHES', 2),
        maxPendingBatches: getIntEnvWithFallback('MAX_PENDING_BATCHES', 2),
        compressionLevel: getIntEnvWithFallback('COMPRESSION_LEVEL', 4),
      },
      interceptConsole: getBoolEnvWithFallback('INTERCEPT_CONSOLE', false),
      preserveOriginalConsole: getBoolEnvWithFallback('PRESERVE_ORIGINAL_CONSOLE', true),
      enableMetrics: getBoolEnvWithFallback('ENABLE_METRICS', false),
      enableHealthCheck: getBoolEnvWithFallback('ENABLE_HEALTH_CHECK', true),
      debug: getBoolEnvWithFallback('DEBUG', false),
      silentErrors: getBoolEnvWithFallback('SILENT_ERRORS', false),
    };

    if (enableLogging && exportMode === 'collector' && !collectorLogsEndpoint && !collectorEndpoint) {
      console.warn('[unified-observability] Collector mode requires OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.');
    } else if (enableLogging && exportMode === 'direct' && !process.env.LOGS_URL && !process.env.LOKI_URL) {
      console.warn('[unified-observability] Direct log export is degraded: LOGS_URL is required and no endpoint default is used.');
    } else if (enableLogging && exportMode === 'direct' && !getEnv('TENANT')) {
      console.warn('[unified-observability] Direct log export is degraded: LOGS_TENANT is required and no tenant default is used.');
    } else if (process.env.LOGS_DEBUG === 'true') {
      console.log(`[unified-observability] Initializing with compression: ${compression}`);
      console.log(`[unified-observability] Export mode: ${exportMode}`);
    }

    await init({
      serviceName,
      version,
      environment,
      exportMode,
      ...(exportMode === 'collector' ? {
        collector: {
          endpoint: collectorEndpoint || '',
          logsEndpoint: collectorLogsEndpoint,
          tracesEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
          metricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
        },
      } : {}),
      enableLogging,
      enableMetrics,
      enableTracing,
      initializationTimeoutMillis: getIntEnv('UO_INITIALIZATION_TIMEOUT_MS', 5000),
      shutdownTimeoutMillis: getIntEnv('UO_SHUTDOWN_TIMEOUT_MS', 5000),
      logging: loggingConfig,
      telemetry: {
        autoShutdown: true,
        tracing: {
          enabled: enableTracing,
          ...(tracingSamplingRatio !== undefined
            ? { sampling: { ratio: tracingSamplingRatio } }
            : {}),
        },
        metrics: {
          enabled: enableMetrics,
          exportIntervalMillis: getIntEnv('OTEL_METRIC_EXPORT_INTERVAL', 60000),
          exportTimeoutMillis: getIntEnv('OTEL_METRIC_EXPORT_TIMEOUT', 10000),
          cardinalityLimit: getIntEnv('OTEL_METRICS_CARDINALITY_LIMIT', 200),
          maxExportBatchSize: getIntEnv('OTEL_METRIC_EXPORT_BATCH_SIZE', 256),
        },
      }
    });

    if (process.env.LOGS_DEBUG === 'true' || process.env.LOKI_DEBUG === 'true') {
      console.log('[unified-observability] Auto-registration completed.');
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[unified-observability] Auto-registration failed:', message);
  }
};

bootstrap();
