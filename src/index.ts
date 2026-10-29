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
let abandonedTelemetryCleanup: Promise<void> | null = null;
let fallbackTracer: TracerFacade | null = null;
let fallbackMetrics: MetricFacade | null = null;
let activeLogger: ILogger = logger as any;
let gracefulShutdownHookRegistered = false;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let loggingActive = false;
let lifecycleTimeoutMillis = 5000;
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
    await withTimeout(shutdownPromise, lifecycleTimeoutMillis, 'previous shutdown');
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
  lifecycleTimeoutMillis = boundedTimeout(config.shutdownTimeoutMillis);

  // Feature Flags (Default to true)
  const enableLogging = config.enableLogging ?? true;
  const enableMetrics = normalizeMetricsConfig(config.telemetry?.metrics, config.enableMetrics ?? true).enabled ?? true;
  const enableTracing = normalizeTracingConfig(config.telemetry?.tracing, config.telemetry?.sampling, config.enableTracing ?? true).enabled ?? true;
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
      loggingActive = true;
      currentStatus.components.logging = 'ready';
    } catch (err) {
      const message = formatError(err);
      errors.push({ component: 'logging', message });
      console.error('[unified-observability] Failed to initialize logger:', message);
    }
  }

  // 2. Initialize Telemetry
  if (enableTracing || enableMetrics) try {
    assertCollectorTelemetryEndpoints(config, enableTracing, enableMetrics);
    const telemetryConfig = buildTelemetryConfig(buildTelemetryForExportMode(config), {
      serviceName,
      serviceVersion: version,
      deploymentEnvironment: environment,
    }, {
      enableMetrics,
      enableTracing,
    });
    let abandoned = false;
    const pendingTelemetry = initObservability(telemetryConfig);
    const pendingCleanup = pendingTelemetry.then(async (handle) => {
      if (abandoned) await handle.shutdown();
    }, () => {});
    void pendingCleanup.catch(() => {});
    try {
      telemetryHandle = await withTimeout(
        pendingTelemetry, boundedTimeout(config.initializationTimeoutMillis), 'initialization'
      );
    } catch (error) {
      abandoned = true;
      abandonedTelemetryCleanup = pendingCleanup;
      throw error;
    }
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
    const cleanupResults = await Promise.allSettled([shutdown()]);
    currentStatus = { ...currentStatus, healthy: false, partial: false, errors: [
      ...errors, ...rejectedMessages(cleanupResults).map((message) => ({ component: 'telemetry' as const, message })),
    ] };
    throw new Error(`Unified observability initialization failed: ${formatInitializationErrors(errors)}`);
  }

  if ((loggingActive || telemetryHandle) && (config.telemetry?.autoShutdown ?? true) && !gracefulShutdownHookRegistered) {
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
    withTimeout(invoke(() => loggingActive ? activeLogger.flush() : Promise.resolve()), lifecycleTimeoutMillis, 'logger flush'),
    withTimeout(invoke(() => telemetryHandle?.forceFlush() ?? Promise.resolve()), lifecycleTimeoutMillis, 'telemetry flush'),
  ]);
  throwIfRejected(results, 'Unified observability force flush failed');
}

export async function shutdown(): Promise<void> {
  if (lifecycleState === 'idle') return;
  if (lifecycleState === 'stopping' && shutdownPromise) {
    return withTimeout(shutdownPromise, lifecycleTimeoutMillis, 'shutdown');
  }
  if (lifecycleState === 'starting' && initializationPromise) {
    return withTimeout(initializationPromise.then(() => shutdown(), () => shutdown()),
      lifecycleTimeoutMillis, 'shutdown during initialization');
  }

  lifecycleState = 'stopping';
  currentStatus = { ...currentStatus, state: 'stopping' };
  const handle = telemetryHandle;
  const lateCleanup = abandonedTelemetryCleanup;
  const destroyLogging = loggingActive;
  telemetryHandle = null;
  loggingActive = false;
  activeLogger = logger as any;

  shutdownPromise = (async () => {
    const results = await Promise.allSettled([
      invoke(() => destroyLogging ? destroyLogger() : Promise.resolve()),
      invoke(() => handle?.shutdown() ?? Promise.resolve()),
      lateCleanup ?? Promise.resolve(),
    ]);
    const errors = rejectedMessages(results);
    lifecycleState = 'idle';
    abandonedTelemetryCleanup = null;
    shutdownPromise = null;
    removeGracefulShutdownHooks();
    currentStatus = createIdleStatus(
      errors.map((message) => ({ component: 'telemetry', message }))
    );
    if (errors.length > 0) {
      throw new Error(`Unified observability shutdown failed: ${errors.join('; ')}`);
    }
  })();

  return withTimeout(shutdownPromise, lifecycleTimeoutMillis, 'shutdown');
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
  const strictTelemetryPassthrough = { ...telemetryPassthrough, failOpen: false };
  return {
    ...strictTelemetryPassthrough,
    autoShutdown: false,
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
      .map(formatError)
      .join('; ');
    throw new Error(`${message}: ${details}`);
  }
}

function registerGracefulShutdownHook(): void {
  gracefulShutdownHookRegistered = true;
  const onSignal = async (signal: NodeJS.Signals) => {
    const hadExplicitExitCode = process.exitCode !== undefined;
    const hadApplicationHandler = process.listenerCount(signal) > 0;
    try {
      await shutdown();
    } catch (error) {
      console.error(
        `[unified-observability] Shutdown failed on ${signal}:`,
        formatError(error)
      );
    }

    removeGracefulShutdownHooks();
    if (!hadApplicationHandler && !hadExplicitExitCode && process.exitCode === undefined) {
      process.kill(process.pid, signal);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => { void onSignal(signal); };
    signalHandlers.set(signal, handler);
    process.prependOnceListener(signal, handler);
  }
}

function removeGracefulShutdownHooks(): void {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
  gracefulShutdownHookRegistered = false;
}

function boundedTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), 60000) : 5000;
}

async function withTimeout<T>(operation: Promise<T>, millis: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Unified observability ${phase} exceeded ${millis} ms`)), millis);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function invoke<T>(operation: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
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
  try {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    return message.replace(/https?:\/\/[^\s]+/gi, (value) => {
      try { return new URL(value).origin + '/[REDACTED]'; } catch { return '[REDACTED URL]'; }
    }).replace(/((?:password|passwd|token|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  } catch {
    return 'Telemetry component failed with an unreadable error';
  }
}

function rejectedMessages(results: PromiseSettledResult<void>[]): string[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => formatError(result.reason));
}

function formatInitializationErrors(errors: UnifiedInitializationError[]): string {
  return errors.map((error) => `${error.component}: ${error.message}`).join('; ');
}
