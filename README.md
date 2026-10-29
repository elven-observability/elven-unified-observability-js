# Unified Observability JS

A unified wrapper for **Logs Interceptor** and **OpenTelemetry Instrumentation**, designed for **Zero Code** integration.

## Features

- **Zero Code Initialization**: Configure entirely via Environment Variables.
- **Unified Identity**: Consistent Service Name/Version across Logs and Traces.
- **Deep Customization**: Over 30 configuration options (`LOGS_*`).
- **Toggles**: Enable/Disable Logging, Metrics, or Tracing individually.
- **Collector Mode**: Logs, metrics, and traces share one OTLP endpoint; no Loki credential is required by the application.

## Installation

This working tree is the **1.2.0 source candidate**, targeting the exact Elven
instrumentation SDK **2.0.0-rc.1**. It is not a published or production-approved
release. The SDK candidate was unavailable from the public registry during the
2026-09-05 review, so use the checksummed archive workflow in
[Candidate validation](docs/candidate-validation.md) for local tests.

After both exact versions have been published through the release gates:

```bash
npm install elven-unified-observability-js@1.2.0
```

Candidate Node support is 20.6+, 22, 24 and 26+. This does not declare every
runtime/framework/platform combination validated. The wrapper keeps its existing
ISC license; the instrumentation dependency has its own license.

## Quick Start (Zero Code)

1. **Configure Environment Variables**:

   ```bash
   # Service Identity
   export OTEL_SERVICE_NAME="my-service"
   export NODE_ENV="production"

   # All signals through one OTLP collector
   export ELVEN_EXPORTER_MODE="collector"
   export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"
   export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
   export OTEL_LOGS_EXPORTER="otlp"
   export OTEL_TRACES_EXPORTER="otlp"
   export OTEL_METRICS_EXPORTER="otlp"

   # Optional Toggles
   export ENABLE_LOGGING="true"
   export ENABLE_TRACING="true"
   export ENABLE_METRICS="true"
   export OTEL_TRACES_SAMPLER="always_on"
   ```

2. **Run Application**:

   ```bash
   NODE_OPTIONS="--require elven-unified-observability-js/register" node dist/server.js
   ```

   The register preload reads the process environment supplied by the runtime.
   It does not load `.env` files automatically.

   On `SIGINT` or `SIGTERM`, the unified wrapper flushes and shuts down logs,
   traces, and metrics before the process exits.

3. **Development (ts-node-dev / nodemon)**:

   If using `ts-node-dev`, enable the register script via `--require` or `NODE_OPTIONS`:

   ```bash
   # Option A: Command Line Flag (Recommended)
   ts-node-dev --require elven-unified-observability-js/register --respawn server.ts

   # Option B: Environment Variable
   export NODE_OPTIONS="--require elven-unified-observability-js/register"
   ts-node-dev --respawn server.ts
   ```

4. **Production (PM2)**:

   For PM2, add `node_args` (best practice) or `NODE_OPTIONS` in your `ecosystem.config.js`:

   ```javascript
   module.exports = {
     apps: [
       {
         name: "my-app",
         script: "./dist/index.js",
         // Option A: Specific Node Arguments (Recommended for PM2)
         node_args: "-r elven-unified-observability-js/register",

         // Option B: Environment Variable
         env: {
           NODE_ENV: "production",
           NODE_OPTIONS: "--require elven-unified-observability-js/register",
         },
       },
     ],
   };
   ```

## Configuration Reference

### Core

| Variable               | Description               | Default |
| ---------------------- | ------------------------- | ------- |
| `OTEL_SERVICE_NAME`    | Service Name              | `unknown-service` |
| `OTEL_SERVICE_VERSION` | Service Version           | `1.0.0` |
| `ENABLE_LOGGING`       | Master switch for logging | `true` |
| `ENABLE_METRICS`       | Master switch for metrics | `true` |
| `ENABLE_TRACING`       | Master switch for tracing | `true` |
| `ELVEN_EXPORTER_MODE`  | `direct` or unified `collector` routing | `direct` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Shared OTLP collector base URL | - |
| `OTEL_TRACES_SAMPLING_RATIO` | Trace sampling ratio | `0.1` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in ms | `60000` |
| `OTEL_METRIC_EXPORT_TIMEOUT` | Metric export timeout in ms | `10000` |
| `OTEL_METRICS_CARDINALITY_LIMIT` | Cardinality limit per instrument | `200` |
| `OTEL_METRIC_EXPORT_BATCH_SIZE` | Maximum metric export batch | `256` |

### Logging (Prefix: `LOGS_`)

_Note: `LOKI_` prefix is also supported for backward compatibility.\_

| Variable                  | Description        | Default  |
| ------------------------- | ------------------ | -------- |
| `LOGS_URL`                | Loki Push API URL  | required in direct mode |
| `LOGS_TENANT`             | Tenant ID          | required in direct mode |
| `LOGS_TOKEN`              | Auth Token         | -        |
| `LOGS_COMPRESSION`        | `gzip`, `brotli`   | `gzip`   |
| `LOGS_USE_WORKERS`        | Use worker threads | `false`  |
| `LOGS_CONNECTION_POOLING` | HTTP keep-alive    | `true`   |

In collector mode, `LOGS_URL`, `LOGS_TENANT`, and `LOGS_TOKEN` are not used.
The package sends logs to `/v1/logs`, traces to `/v1/traces`, and metrics to
`/v1/metrics` under the shared OTLP endpoint.

### Buffer & Performance

| Variable                      | Description           | Default |
| ----------------------------- | --------------------- | ------- |
| `LOGS_BUFFER_MAX_SIZE`        | Max logs before flush | `250` |
| `LOGS_BUFFER_FLUSH_INTERVAL`  | ms between flushes    | `2000` |
| `LOGS_MAX_CONCURRENT_FLUSHES` | Concurrent requests   | `2` |
| `LOGS_MAX_PENDING_BATCHES`    | Bounded pending batches (`drop-oldest`) | `2` |
| `LOGS_BUFFER_MAX_MEMORY_MB`   | Active log buffer memory budget | `32` |

### Filtering & Resilience

| Variable                       | Description              | Default |
| ------------------------------ | ------------------------ | ------- |
| `LOGS_FILTER_LEVELS`           | `debug,info,warn,error,fatal` | `info,warn,error,fatal` |
| `LOGS_CIRCUIT_BREAKER_ENABLED` | Enable circuit breaker   | `true` |
| `LOGS_DLQ_ENABLED`             | Enable Dead Letter Queue | `true` |
| `LOGS_INTERCEPT_CONSOLE`       | Capture console logs     | `false` |
| `LOGS_FILTER_MAX_CONTEXT_BYTES` | Maximum serialized context bytes | `16384` |

## Manual Lifecycle

```ts
import { init } from 'elven-unified-observability-js';

const observability = await init({
  serviceName: 'billing-service',
  exportMode: 'collector',
  collector: { endpoint: 'http://otel-collector:4318' },
  failOpen: true,
  telemetry: { autoShutdown: false },
});

// Use the returned handle after initialization for manual spans and metrics.
await observability.tracer.withSpan('billing-operation', async () => {
  observability.logger.info('billing-operation-complete');
});

const status = observability.getStatus();
// Each component is ready, degraded, or disabled.
console.log(status.healthy, status.partial, status.components, status.errors);

await observability.forceFlush();
await observability.shutdown();
```

`failOpen` defaults to `true`: a logger or telemetry startup failure is exposed
in the returned status without stopping the application. Set it to `false` for
strict startup, which cleans up successful components before rejecting. Signal
cleanup never calls `process.exit(0)`; explicit application exit codes and the
default SIGINT/SIGTERM lifecycle are preserved.

SDK facades are initialized asynchronously. In CommonJS, avoid destructuring
`tracer` or `metrics` before `await init(...)`; use the returned handle. When
initialization is degraded, inspect component status before making manual
telemetry claims. The returned handle retains API-backed fallback facades when
the telemetry SDK cannot start; with no provider installed, those calls are
no-ops and application callbacks still execute. The degraded status and error
are preserved. Automatic application startup remains fail-open by default.
