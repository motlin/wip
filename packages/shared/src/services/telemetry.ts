import { trace, type Tracer } from "@opentelemetry/api";

declare global {
  // eslint-disable-next-line no-var
  var __otelInitialized: boolean | undefined;
}

function isTracingEnabled(): boolean {
  return process.env["WIP_TRACING"] === "true";
}

async function initTracing(): Promise<void> {
  if (!isTracingEnabled()) {
    return;
  }

  if (globalThis.__otelInitialized) {
    return;
  }
  globalThis.__otelInitialized = true;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");
  const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
  const sdk = new NodeSDK({
    serviceName: "wip",
    traceExporter: new OTLPTraceExporter({
      url: "http://localhost:4318/v1/traces",
    }),
    instrumentations: [new HttpInstrumentation()],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    void sdk.shutdown();
  });
}

void initTracing();

export function getTracer(name = "wip"): Tracer {
  return trace.getTracer(name);
}
