import { LogsInterceptorConfig } from 'elven-logs-interceptor';
import type { initObservability } from 'elven-opentelemetry-instrumentation-js';

type SdkObservabilityConfig = Parameters<typeof initObservability>[0];
type SdkSamplingConfig = NonNullable<NonNullable<SdkObservabilityConfig['tracing']>['sampling']>;

export interface TelemetryInstrumentationToggle {
  enabled?: boolean;
}

export interface TelemetryInstrumentationsConfig {
  http?: boolean | TelemetryInstrumentationToggle;
  express?: boolean | TelemetryInstrumentationToggle;
  fastify?: boolean | TelemetryInstrumentationToggle;
  graphql?: boolean | TelemetryInstrumentationToggle;
  pg?: boolean | TelemetryInstrumentationToggle;
  mysql?: boolean | TelemetryInstrumentationToggle;
  mongodb?: boolean | TelemetryInstrumentationToggle;
  mongoose?: boolean | TelemetryInstrumentationToggle;
  redis?: boolean | TelemetryInstrumentationToggle;
  knex?: boolean | TelemetryInstrumentationToggle;
  genericPool?: boolean | TelemetryInstrumentationToggle;
  nestjs?: boolean | TelemetryInstrumentationToggle;
  koa?: boolean | TelemetryInstrumentationToggle;
  dns?: boolean | TelemetryInstrumentationToggle;
  net?: boolean | TelemetryInstrumentationToggle;
  pino?: boolean | TelemetryInstrumentationToggle;
  winston?: boolean | TelemetryInstrumentationToggle;
  [key: string]: boolean | TelemetryInstrumentationToggle | undefined;
}

export interface TelemetrySamplingConfig extends SdkSamplingConfig {
  [key: string]: unknown;
}

export interface TelemetryTracingConfig {
  enabled?: boolean;
  sampling?: TelemetrySamplingConfig;
  [key: string]: unknown;
}

export interface TelemetryMetricsConfig {
  enabled?: boolean;
  exportIntervalMillis?: number;
  exportTimeoutMillis?: number;
  cardinalityLimit?: number;
  maxExportBatchSize?: number;
  [key: string]: unknown;
}

export type TelemetryPrivacyConfig = NonNullable<SdkObservabilityConfig['privacy']>;

export interface TelemetryServiceOverride {
  serviceName?: string;
  serviceVersion?: string;
  serviceNamespace?: string;
  deploymentEnvironment?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface UnifiedCollectorConfig {
  /** Base OTLP/HTTP endpoint. Signal paths are appended automatically. */
  endpoint: string;
  /** Exact OTLP logs endpoint override. */
  logsEndpoint?: string;
  /** Exact OTLP traces endpoint override. */
  tracesEndpoint?: string;
  /** Exact OTLP metrics endpoint override. */
  metricsEndpoint?: string;
  /** Optional collector headers. Applications normally do not need credentials here. */
  headers?: Record<string, string>;
}

export interface TelemetryConfig {
  /**
   * Runtime environment.
   */
  runtime?: 'node' | 'serverless' | 'edge';

  /** Let the unified wrapper flush all signals on SIGINT/SIGTERM. */
  autoShutdown?: boolean;

  /**
   * Exporter configuration passed through to OTel.
   */
  exporters?: SdkObservabilityConfig['exporters'];

  /**
   * Instrumentation toggles.
   */
  instrumentations?: TelemetryInstrumentationsConfig | boolean;

  /**
   * Privacy defaults for attribute sanitization.
   */
  privacy?: TelemetryPrivacyConfig;

  /**
   * v1 compatibility: top-level sampling.
   */
  sampling?: TelemetrySamplingConfig;

  /**
   * Metrics config:
   * - v1: boolean
   * - v2: object with enabled/exportIntervalMillis
   */
  metrics?: boolean | TelemetryMetricsConfig;

  /**
   * Tracing config:
   * - v1: boolean
   * - v2: object with enabled/sampling
   */
  tracing?: boolean | TelemetryTracingConfig;

  /**
   * Optional service override merged with unified service identity.
   */
  service?: TelemetryServiceOverride;

  /**
   * Additional vendor-specific keys are forwarded to OTel config.
   */
  [key: string]: unknown;
}

// Re-export specific logs config for convenience, or alias them
export type TransportConfig = LogsInterceptorConfig['transport'];
export type FilterConfig = LogsInterceptorConfig['filter'];

export interface UnifiedObservabilityConfig {
  /**
   * Service Name - used for both logs and telemetry resources
   */
  serviceName: string;

  /**
   * Service Version - used for both logs and telemetry resources
   * Default: 1.0.0
   */
  version?: string;

  /**
   * Environment (e.g., production, staging, development)
   * Default: development
   */
  environment?: string;

  /** Route logs, metrics and traces through one OTLP collector. */
  exportMode?: 'direct' | 'collector';

  /** Collector endpoint used when exportMode is collector. */
  collector?: UnifiedCollectorConfig;

  /** Keep application startup alive when one telemetry component cannot start. */
  failOpen?: boolean;

  /** Maximum async initialization wait; default 5000 ms, maximum 60000 ms. */
  initializationTimeoutMillis?: number;

  /** Maximum flush/shutdown wait; default 5000 ms, maximum 60000 ms. */
  shutdownTimeoutMillis?: number;

  /**
   * Enable/Disable Logging
   * Default: true
   */
  enableLogging?: boolean;

  /**
   * Enable/Disable Metrics
   * Default: true
   */
  enableMetrics?: boolean;

  /**
   * Enable/Disable Tracing
   * Default: true
   */
  enableTracing?: boolean;

  /**
   * Logging Configuration (Logs Interceptor)
   */
  logging?: Omit<LogsInterceptorConfig, 'appName' | 'version' | 'environment'>;

  /**
   * Telemetry Configuration (OpenTelemetry)
   */
  telemetry?: TelemetryConfig;
}

export type UnifiedComponentState = 'disabled' | 'ready' | 'degraded';

export interface UnifiedInitializationError {
  component: 'logging' | 'telemetry';
  message: string;
}

export interface UnifiedObservabilityStatus {
  state: 'idle' | 'starting' | 'started' | 'stopping';
  healthy: boolean;
  partial: boolean;
  components: {
    logging: UnifiedComponentState;
    tracing: UnifiedComponentState;
    metrics: UnifiedComponentState;
  };
  errors: UnifiedInitializationError[];
}
