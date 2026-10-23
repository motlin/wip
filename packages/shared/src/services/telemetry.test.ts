import * as net from "node:net";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

// Importing telemetry.ts auto-starts tracing when WIP_TRACING=true (exported by
// .envrc), which would register a global provider aimed at a real collector.
vi.hoisted(() => {
	delete process.env["WIP_TRACING"];
});

const {getTracer, startTracing} = await import("./telemetry.js");

async function closedPortUrl(): Promise<string> {
	const server = net.createServer();
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("expected a TCP address");
	}
	await new Promise<void>((resolve) => {
		server.close(() => {
			resolve();
		});
	});
	return `http://127.0.0.1:${address.port}/v1/traces`;
}

describe("startTracing against an unreachable collector", () => {
	const failures: unknown[] = [];
	const onFailure = (error: unknown): void => {
		failures.push(error);
	};

	beforeEach(() => {
		failures.length = 0;
		// Keep each failed export (and its retries) short.
		vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "300");
		process.on("unhandledRejection", onFailure);
		process.on("uncaughtException", onFailure);
	});

	afterEach(() => {
		process.off("unhandledRejection", onFailure);
		process.off("uncaughtException", onFailure);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("flushes and shuts down without crashing the process, warning once", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const tracing = await startTracing(await closedPortUrl());

		getTracer("telemetry-test").startSpan("first").end();
		await tracing.flush();
		getTracer("telemetry-test").startSpan("second").end();
		await tracing.flush();
		getTracer("telemetry-test").startSpan("third").end();
		await tracing.shutdown();
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});

		expect({failures, warnCalls: warn.mock.calls.length}).toStrictEqual({failures: [], warnCalls: 1});
	});
});
