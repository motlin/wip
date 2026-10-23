import {trace, type Tracer} from "@opentelemetry/api";
import type {tracing as sdkTracing} from "@opentelemetry/sdk-node";

declare global {
	// eslint-disable-next-line no-var
	var wipOtelInitialized: boolean | undefined;
}

const DEFAULT_TRACES_URL = "http://127.0.0.1:4318/v1/traces";

function isTracingEnabled(): boolean {
	return process.env["WIP_TRACING"] === "true";
}

export interface Tracing {
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

// Telemetry must never take the server down. An unreachable collector makes
// every export fail, and forceFlush/shutdown reject with that error; callers that
// `void` those promises turn it into a fatal unhandled rejection. Every export
// path below reports failure through warnOnce instead.
export async function startTracing(url: string): Promise<Tracing> {
	const {NodeSDK, core, tracing} = await import("@opentelemetry/sdk-node");
	const {OTLPTraceExporter} = await import("@opentelemetry/exporter-trace-otlp-proto");
	const {HttpInstrumentation} = await import("@opentelemetry/instrumentation-http");

	let warned = false;
	const warnOnce = (error: unknown): void => {
		if (warned) return;
		warned = true;
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(`[wip] trace export to ${url} failed; tracing continues without a collector: ${reason}`);
	};

	const otlp = new OTLPTraceExporter({url});
	const exporter: sdkTracing.SpanExporter = {
		export: (spans, resultCallback) => {
			otlp.export(spans, (result) => {
				if (result.code !== core.ExportResultCode.SUCCESS) {
					warnOnce(result.error);
				}
				resultCallback(result);
			});
		},
		shutdown: async () => otlp.shutdown(),
		forceFlush: async () => otlp.forceFlush(),
	};
	const processor = new tracing.BatchSpanProcessor(exporter);
	const sdk = new NodeSDK({
		serviceName: "wip",
		spanProcessors: [processor],
		instrumentations: [new HttpInstrumentation()],
	});

	sdk.start();

	return {
		flush: async () => processor.forceFlush().catch(warnOnce),
		shutdown: async () => sdk.shutdown().catch(warnOnce),
	};
}

async function initTracing(): Promise<void> {
	if (!isTracingEnabled()) {
		return;
	}

	if (globalThis.wipOtelInitialized) {
		return;
	}
	globalThis.wipOtelInitialized = true;

	const tracing = await startTracing(process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ?? DEFAULT_TRACES_URL);
	process.on("SIGTERM", () => {
		void tracing.shutdown();
	});
}

void initTracing().catch((error: unknown) => {
	console.warn("[wip] tracing failed to start:", error);
});

export function getTracer(name = "wip"): Tracer {
	return trace.getTracer(name);
}
