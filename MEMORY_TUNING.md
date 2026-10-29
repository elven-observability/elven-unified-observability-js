# Memory tuning

This package is loaded before the application with:

```bash
NODE_OPTIONS="--require elven-unified-observability-js/register"
```

For memory constrained containers, avoid enabling every signal at full volume on
the first rollout. Start with bounded logs, then re-enable tracing/metrics
gradually.

## Immediate OOM mitigation

Use these overrides when the app starts exceeding its usual memory profile:

```bash
LOGS_INTERCEPT_CONSOLE=false
LOGS_USE_WORKERS=false
LOGS_BUFFER_MAX_SIZE=250
LOGS_BUFFER_MAX_MEMORY_MB=32
LOGS_MAX_CONCURRENT_FLUSHES=2
LOGS_MAX_PENDING_BATCHES=2
LOGS_MAX_SOCKETS=10
LOGS_FILTER_LEVELS=info,warn,error,fatal
LOGS_FILTER_MAX_MESSAGE_LENGTH=2048
LOGS_FILTER_MAX_CONTEXT_BYTES=16384
LOGS_COMPRESSION=gzip
LOGS_DEBUG=false
OTEL_TRACES_SAMPLING_RATIO=0.1
OTEL_METRIC_EXPORT_INTERVAL=60000
OTEL_METRIC_EXPORT_TIMEOUT=10000
OTEL_METRICS_CARDINALITY_LIMIT=200
OTEL_METRIC_EXPORT_BATCH_SIZE=256
```

If the process still grows, isolate OpenTelemetry from log shipping:

```bash
OTEL_TRACES_EXPORTER=none
OTEL_METRICS_EXPORTER=none
```

If logs are still too noisy, sample application logs temporarily:

```bash
LOGS_FILTER_SAMPLING_RATE=0.2
```

## Why these settings matter

- `LOGS_INTERCEPT_CONSOLE=true` can duplicate every `console.*` call into the
  Loki buffer. Noisy apps can create high allocation pressure even when the app
  does not call the Elven logger directly.
- `LOGS_BUFFER_MAX_MEMORY_MB=512`, large batches, high flush concurrency, and
  many keep-alive sockets can hold much more memory than a 512 CPU / 3 GB
  Fargate task should spend on observability.
- Worker threads help CPU-heavy compression in larger containers, but each
  worker has its own heap and native overhead.
- The pending flush queue is bounded. When Loki is slower than the application,
  old batches are dropped instead of retaining memory until OOM.
- Keeping `debug` enabled in production usually multiplies log volume without
  improving incident signal.

## Rollout order

1. Start with logs only and the bounded settings above.
2. Confirm RSS and heap stay flat under normal traffic.
3. Re-enable metrics.
4. Re-enable tracing with a sampling strategy or with only the instrumentations
   the service actually needs.
