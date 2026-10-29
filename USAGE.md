# Guia de Integração: Unified Observability

Esta biblioteca centraliza a instrumentação de Logs, Métricas e Traces.
Este guia acompanha a fonte candidata 1.2.0 e seus controles de ciclo de vida.
Não é comprovação de publicação. Para uma versão já instalada, consulte o
README da tag correspondente; métodos novos podem não existir nela.

## 1. Instalação

```bash
npm view elven-unified-observability-js versions --json
```

Confirme a versão estável no registro antes da instalação. A publicação 1.2.0
depende da validação de seus dois pacotes base, conforme o README.

## 2. Inicialização (Entry Point)

Inicialize antes de carregar os frameworks e clientes que serão instrumentados.
Imports estáticos da aplicação podem executar antes do corpo deste arquivo;
carregue a aplicação depois da inicialização ou use o preload do README.

**Arquivo:** `src/index.ts` ou `src/main.ts`

```typescript
import { init } from "elven-unified-observability-js";

async function bootstrap() {
  const observability = await init({
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
      interceptConsole: false,
    },

    // Confira os limites e o sampling padrão no README.
    telemetry: {
      metrics: { enabled: true },
      tracing: { enabled: true },
    },

    // Controle Geral
    enableLogging: true,
    enableMetrics: true,
    enableTracing: true,
  });

  if (!observability.getStatus().healthy) {
    console.warn("Instrumentação parcialmente indisponível");
  }
  const app = await import("./app");
  await app.start();
}

bootstrap().catch(() => {
  console.error("Falha ao iniciar a aplicação");
  process.exitCode = 1;
});
```

## 3. Uso no Dia a Dia

Depois da inicialização, importe as facades em outros módulos sem repetir
`init`. Na fonte 1.2.0 elas mantêm a identidade em CJS/ESM; em versões
anteriores, prefira o handle retornado ou o acesso ao módulo após init.

**Arquivo:** `src/services/PaymentService.ts`

```typescript
import { logger, tracer, metrics } from "elven-unified-observability-js";

export class PaymentService {
  public async process(orderId: string) {
    return tracer.withSpan("processPayment", async () => {
      logger.info("Tentativa de pagamento", { orderId });
      metrics.getCounter("payment_attempts").add(1);
      return { orderId };
    });
  }
}
```

`withSpan` encerra o span e preserva o resultado ou a exceção do callback.
Não chame `span.end()` novamente. O exemplo é uma operação sintética, não uma
implementação de pagamento. Não use `orderId` como label de métrica.
