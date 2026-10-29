# Guia de Integração: Unified Observability

Esta biblioteca centraliza a instrumentação de Logs, Métricas e Traces.

## 1. Instalação

```bash
npm install --save-exact elven-unified-observability-js@1.1.0
```

## 2. Inicialização (Entry Point)

Deve ser a **primeira coisa** a rodar na sua aplicação (antes de importar outros módulos se possível, para garantir o patch do OpenTelemetry).

**Arquivo:** `src/index.ts` ou `src/main.ts`

```typescript
import { init } from "elven-unified-observability-js";

async function bootstrap() {
  // Inicializa TUDO de uma vez
  await init({
    serviceName: "minha-app-cliente",
    version: "1.0.0",
    environment: process.env.NODE_ENV || "production",

    // Um endpoint OTLP para os tres sinais, sem token Loki na aplicacao
    exportMode: "collector",
    collector: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
    },

    // Configuração de Logs
    logging: {
      transport: {
        type: "otlp",
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
        compression: "gzip",
      },
      // Opcional: Console limpo em prod
      interceptConsole: true,
    },

    // Configuração de Telemetria (Opcional - usa defaults do OTel)
    telemetry: {
      metrics: { enabled: true },
      tracing: { enabled: true },
    },

    // Controle Geral
    enableLogging: true,
    enableMetrics: true,
    enableTracing: true,
  });

  // Inicia sua app...
  import("./app").then((app) => app.start());
}

bootstrap();
```

## 3. Uso no Dia a Dia

Em qualquer outro arquivo, você não precisa passar config ou chamar init. Apenas importe os singletons.

**Arquivo:** `src/services/PaymentService.ts`

```typescript
import { logger, tracer, metrics } from "elven-unified-observability-js";

export class PaymentService {
  public async process(orderId: string) {
    // 1. Logs
    logger.info("Processando pagamento", { orderId });

    // 2. Custom Tracing (Opcional - requests HTTP já são automáticos)
    return tracer.startActiveSpan("processPayment", async (span) => {
      try {
        // Lógica...

        // 3. Métricas Customizadas
        metrics.getMeter("payments").createCounter("payment_success").add(1);

        span.end();
      } catch (err) {
        logger.error("Erro no pagamento", { orderId, error: err });
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }
}
```
