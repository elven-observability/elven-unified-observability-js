import { destroy as destroyLogger, ILogger, init as initLogger, logger } from 'elven-logs-interceptor';
import {
  initObservability,
  MetricFacade,
  metrics,
  type ObservabilityHandle,
  tracer,
  TracerFacade,
} from 'elven-opentelemetry-instrumentation-js';
import {
  TelemetryConfig,
  TelemetryMetricsConfig,
  TelemetrySamplingConfig,
  TelemetryServiceOverride,
  TelemetryTracingConfig,
  UnifiedObservabilityConfig,
  UnifiedInitializationError,
  UnifiedObservabilityStatus,
} from './types';

// Re-export types
export * from './types';

// Re-export compiled singletons
export { logger } from 'elven-logs-interceptor';
export { metrics, tracer } from 'elven-opentelemetry-instrumentation-js';

// Re-export type definitions for usage
export { ILogger, MetricFacade, TracerFacade };

type LifecycleState = 'idle' | 'starting' | 'started' | 'stopping';
type SdkObservabilityConfig = Parameters<typeof initObservability>[0];

let lifecycleState: LifecycleState = 'idle';
let initializationPromise: Promise<UnifiedObservabilityHandle> | null = null;
let shutdownPromise: Promise<void> | null = null;
let telemetryHandle: ObservabilityHandle | null = null;
let fallbackTracer: TracerFacade | null = null;
let fallbackMetrics: MetricFacade | null = null;
let activeLogger: ILogger = logger as any;
let gracefulShutdownHookRegistered = false;
let currentStatus: UnifiedObservabilityStatus = createIdleStatus();

export interface UnifiedObservabilityHandle {
  logger: ILogger;
  tracer: TracerFacade;
  metrics: MetricFacade;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
  isStarted(): boolean;
  getStatus(): UnifiedObservabilityStatus;
}

/**
 * Initialize Unified Observability (Logs + Telemetry)
 * @param config Unified configuration object
 */
export async function init(config: UnifiedObservabilityConfig): Promise<UnifiedObservabilityHandle> {
  if (lifecycleState === 'starting' && initializationPromise) {
    return initializationPromise;
  }
  if (lifecycleState === 'started') {
    return createUnifiedHandle();
  }
  if (lifecycleState === 'stopping' && shutdownPromise) {
    await shutdownPromise;
  }

  const pending = start(config);
  initializationPromise = pending;
  try {
    return await pending;
  } finally {
    if (initializationPromise === pending) initializationPromise = null;
  }
}

async function start(config: UnifiedObservabilityConfig): Promise<UnifiedObservabilityHandle> {
  lifecycleState = 'starting';

  const serviceName = config.serviceName?.trim();
  const version = config.version || '1.0.0';
  const environment = config.environment || 'development';
  const failOpen = config.failOpen ?? true;

  // Feature Flags (Default to true)
  const enableLogging = config.enableLogging ?? true;
  const enableMetrics = config.enableMetrics ?? true;
  const enableTracing = config.enableTracing ?? true;
  const errors: UnifiedInitializationError[] = [];

  currentStatus = {
    state: 'starting',
    healthy: true,
    partial: false,
    components: {
      logging: enableLogging ? 'degraded' : 'disabled',
      tracing: enableTracing ? 'degraded' : 'disabled',
      metrics: enableMetrics ? 'degraded' : 'disabled',
    },
    errors: [],
  };

  if (!serviceName) {
    const error = new Error('serviceName is required');
    currentStatus = createIdleStatus([{
      component: 'telemetry',
      message: error.message,
    }]);
    lifecycleState = 'idle';
    throw error;
  }

  // 1. Initialize Logging (if enabled)
  let loggerInstance: ILogger = logger as any;
  if (enableLogging) {
    try {
      const loggingConfig = buildLoggingConfig(config);
      loggerInstance = initLogger({
        ...loggingConfig,
        appName: serviceName,
        version: version,
        environment: environment,
      });
      activeLogger = loggerInstance;
      currentStatus.components.logging = 'ready';
    } catch (err) {
      const message = formatError(err);
      errors.push({ component: 'logging', message });
      console.error('[unified-observability] Failed to initialize logger:', message);
    }
  }

  // 2. Initialize Telemetry
  try {
    assertCollectorTelemetryEndpoints(config, enableTracing, enableMetrics);
    const telemetryConfig = buildTelemetryConfig(buildTelemetryForExportMode(config), {
      serviceName,
      serviceVersion: version,
      deploymentEnvironment: environment,
    }, {
      enableMetrics,
      enableTracing,
    });
    telemetryHandle = await initObservability(telemetryConfig);
    if (enableTracing) currentStatus.components.tracing = 'ready';
    if (enableMetrics) currentStatus.components.metrics = 'ready';
  } catch (err) {
    const message = formatError(err);
    errors.push({ component: 'telemetry', message });
    console.error('[unified-observability] Failed to initialize telemetry:', message);
  }

  activeLogger = loggerInstance;
  currentStatus = finalizeStartedStatus(currentStatus, errors);
  lifecycleState = 'started';

  if (errors.length > 0 && !failOpen) {
    const cleanupResults = await Promise.allSettled([
      destroyLogger(),
      telemetryHandle?.shutdown() ?? Promise.resolve(),
    ]);
    telemetryHandle = null;
    activeLogger = logger as any;
    lifecycleState = 'idle';
    const cleanupErrors = rejectedMessages(cleanupResults);
    currentStatus = createIdleStatus([
      ...errors,
      ...cleanupErrors.map((message) => ({ component: 'telemetry' as const, message })),
    ]);
    throw new Error(`Unified observability initialization failed: ${formatInitializationErrors(errors)}`);
  }

  if ((config.telemetry?.autoShutdown ?? true) && !gracefulShutdownHookRegistered) {
    registerGracefulShutdownHook();
  }

  return createUnifiedHandle();
}

function assertCollectorTelemetryEndpoints(
  config: UnifiedObservabilityConfig,
  tracingEnabled: boolean,
  metricsEnabled: boolean
): void {
  if (config.exportMode !== 'collector') return;

  const collector = config.collector;
  if (tracingEnabled && !collector?.endpoint && !collector?.tracesEndpoint) {
    throw new Error('Collector mode requires an endpoint for traces');
  }
  if (metricsEnabled && !collector?.endpoint && !collector?.metricsEndpoint) {
    throw new Error('Collector mode requires an endpoint for metrics');
  }
}

function buildLoggingConfig(
  config: UnifiedObservabilityConfig
): NonNullable<UnifiedObservabilityConfig['logging']> {
  if (config.exportMode !== 'collector') {
    return config.logging || { transport: { url: '', tenantId: '' } };
  }

  const endpoint = config.collector?.logsEndpoint || config.collector?.endpoint || '';
  return {
    ...config.logging,
    transport: {
      ...config.logging?.transport,
      type: 'otlp',
      url: endpoint,
      authToken: undefined,
      tenantId: undefined,
      headers: {
        ...config.collector?.headers,
        ...config.logging?.transport?.headers,
      },
    },
  };
}

function buildTelemetryForExportMode(
  config: UnifiedObservabilityConfig
): TelemetryConfig | undefined {
  if (config.exportMode !== 'collector') return config.telemetry;

  const collector = config.collector;
  return {
    ...config.telemetry,
    exporters: {
      ...(config.telemetry?.exporters || {}),
      protocol: 'http/protobuf',
      url: collector?.endpoint,
      tracesUrl: collector?.tracesEndpoint,
      metricsUrl: collector?.metricsEndpoint,
      headers: collector?.headers,
    },
  };
}

export async function forceFlush(): Promise<void> {
  const results = await Promise.allSettled([
    activeLogger.flush(),
    telemetryHandle?.forceFlush() ?? Promise.resolve(),
  ]);
  throwIfRejected(results, 'Unified observability force flush failed');
}

export async function shutdown(): Promise<void> {
  if (lifecycleState === 'idle') return;
  if (lifecycleState === 'stopping' && shutdownPromise) return shutdownPromise;
  if (lifecycleState === 'starting' && initializationPromise) {
    await initializationPromise;
  }

  lifecycleState = 'stopping';
  currentStatus = { ...currentStatus, state: 'stopping' };
  const handle = telemetryHandle;
  telemetryHandle = null;
  activeLogger = logger as any;

  shutdownPromise = (async () => {
    const results = await Promise.allSettled([
      destroyLogger(),
      handle?.shutdown() ?? Promise.resolve(),
    ]);
    const errors = rejectedMessages(results);
    lifecycleState = 'idle';
    shutdownPromise = null;
    currentStatus = createIdleStatus(
      errors.map((message) => ({ component: 'telemetry', message }))
    );
    if (errors.length > 0) {
      throw new Error(`Unified observability shutdown failed: ${errors.join('; ')}`);
    }
  })();

  return shutdownPromise;
}

export function isInitialized(): boolean {
  return lifecycleState === 'started';
}

export function getStatus(): UnifiedObservabilityStatus {
  return cloneStatus(currentStatus);
}

function createUnifiedHandle(): UnifiedObservabilityHandle {
  // API facades do not register another provider. Before an SDK is available,
  // OpenTelemetry supplies no-op implementations so fail-open stays usable.
  if (!telemetryHandle) {
    fallbackTracer ??= new TracerFacade('elven-unified-fallback');
    fallbackMetrics ??= new MetricFacade('elven-unified-fallback');
  }
  return {
    logger: activeLogger,
    tracer: telemetryHandle?.tracer ?? fallbackTracer!,
    metrics: telemetryHandle?.metrics ?? fallbackMetrics!,
    forceFlush,
    shutdown,
    isStarted: isInitialized,
    getStatus,
  };
}

function buildTelemetryConfig(
  telemetry: TelemetryConfig | undefined,
  serviceIdentity: {
    serviceName: string;
    serviceVersion: string;
    deploymentEnvironment: string;
  },
  featureFlags: {
    enableMetrics: boolean;
    enableTracing: boolean;
  }
): SdkObservabilityConfig {
  const safeTelemetry = telemetry || {};
  const {
    service,
    metrics: telemetryMetrics,
    tracing: telemetryTracing,
    sampling: legacySampling,
    instrumentations,
    ...telemetryPassthrough
  } = safeTelemetry;

  const mergedService = buildServiceConfig(serviceIdentity, service);
  return {
    ...telemetryPassthrough,
    autoShutdown: false,
    failOpen: false,
    service: mergedService,
    instrumentations: normalizeInstrumentations(instrumentations),
    metrics: normalizeMetricsConfig(telemetryMetrics, featureFlags.enableMetrics),
    tracing: normalizeTracingConfig(telemetryTracing, legacySampling, featureFlags.enableTracing),
  };
}

function normalizeInstrumentations(
  instrumentations: TelemetryConfig['instrumentations']
): SdkObservabilityConfig['instrumentations'] {
  if (typeof instrumentations === 'boolean' || instrumentations === undefined) {
    return instrumentations;
  }

  return Object.fromEntries(
    Object.entries(instrumentations).map(([name, value]) => [
      name,
      typeof value === 'boolean' ? { enabled: value } : value,
    ])
  );
}

function buildServiceConfig(
  identity: {
    serviceName: string;
    serviceVersion: string;
    deploymentEnvironment: string;
  },
  override: TelemetryServiceOverride | undefined
): SdkObservabilityConfig['service'] {
  return {
    serviceName: override?.serviceName || identity.serviceName,
    serviceVersion: override?.serviceVersion || identity.serviceVersion,
    deploymentEnvironment: override?.deploymentEnvironment || identity.deploymentEnvironment,
    ...(override?.serviceNamespace ? { serviceNamespace: override.serviceNamespace } : {}),
    ...(override?.attributes ? { attributes: override.attributes } : {}),
  };
}

function normalizeMetricsConfig(
  telemetryMetrics: TelemetryConfig['metrics'],
  enabledByDefault: boolean
): TelemetryMetricsConfig {
  if (typeof telemetryMetrics === 'boolean') {
    return { enabled: enabledByDefault && telemetryMetrics };
  }

  if (isRecord(telemetryMetrics)) {
    const metricsConfig = telemetryMetrics as TelemetryMetricsConfig;
    return {
      ...metricsConfig,
      enabled: enabledByDefault && (metricsConfig.enabled ?? true),
    };
  }

  return { enabled: enabledByDefault };
}

function normalizeTracingConfig(
  telemetryTracing: TelemetryConfig['tracing'],
  legacySampling: TelemetrySamplingConfig | undefined,
  enabledByDefault: boolean
): TelemetryTracingConfig {
  if (typeof telemetryTracing === 'boolean') {
    return {
      enabled: enabledByDefault && telemetryTracing,
      ...(legacySampling ? { sampling: legacySampling } : {}),
    };
  }

  if (isRecord(telemetryTracing)) {
    const tracingConfig = telemetryTracing as TelemetryTracingConfig;
    return {
      ...tracingConfig,
      enabled: enabledByDefault && (tracingConfig.enabled ?? true),
      ...(tracingConfig.sampling ? {} : legacySampling ? { sampling: legacySampling } : {}),
    };
  }

  return {
    enabled: enabledByDefault,
    ...(legacySampling ? { sampling: legacySampling } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function throwIfRejected(
  results: PromiseSettledResult<void>[],
  message: string
): void {
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) {
    const details = errors
      .map((error) => error instanceof Error ? error.message : String(error))
      .join('; ');
    throw new Error(`${message}: ${details}`);
  }
}

function registerGracefulShutdownHook(): void {
  gracefulShutdownHookRegistered = true;
  const onSignal = async (signal: NodeJS.Signals) => {
    const hadExplicitExitCode = process.exitCode !== undefined;
    try {
      await shutdown();
    } catch (error) {
      console.error(
        `[unified-observability] Shutdown failed on ${signal}:`,
        formatError(error)
      );
    }

    gracefulShutdownHookRegistered = false;
    if (!hadExplicitExitCode && process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
    }
  };

  process.once('SIGINT', () => { void onSignal('SIGINT'); });
  process.once('SIGTERM', () => { void onSignal('SIGTERM'); });
}

function finalizeStartedStatus(
  status: UnifiedObservabilityStatus,
  errors: UnifiedInitializationError[]
): UnifiedObservabilityStatus {
  const states = Object.values(status.components);
  const hasReady = states.includes('ready');
  const hasDegraded = states.includes('degraded');
  return {
    ...status,
    state: 'started',
    healthy: !hasDegraded && errors.length === 0,
    partial: hasReady && (hasDegraded || errors.length > 0),
    errors: errors.map((error) => ({ ...error })),
  };
}

function createIdleStatus(
  errors: UnifiedInitializationError[] = []
): UnifiedObservabilityStatus {
  return {
    state: 'idle',
    healthy: errors.length === 0,
    partial: false,
    components: {
      logging: 'disabled',
      tracing: 'disabled',
      metrics: 'disabled',
    },
    errors: errors.map((error) => ({ ...error })),
  };
}

function cloneStatus(status: UnifiedObservabilityStatus): UnifiedObservabilityStatus {
  return {
    ...status,
    components: { ...status.components },
    errors: status.errors.map((error) => ({ ...error })),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectedMessages(results: PromiseSettledResult<void>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => formatError(result.reason));
}

function formatInitializationErrors(errors: UnifiedInitializationError[]): string {
  return errors.map((error) => `${error.component}: ${error.message}`).join('; ');
}
