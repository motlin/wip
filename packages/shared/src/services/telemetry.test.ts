import {spawn} from "node:child_process";
import * as net from "node:net";
import {fileURLToPath, pathToFileURL} from "node:url";
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

// Registering a SIGTERM/SIGINT listener disables Node's default exit, so the
// tracing handler must exit on its own once shutdown finishes or times out.
describe("signal handling with tracing enabled", () => {
	const telemetryPath = fileURLToPath(new URL("./telemetry.ts", import.meta.url));

	async function exitAfterSignal(
		signal: NodeJS.Signals,
	): Promise<{code: number | null; signal: NodeJS.Signals | null; withinDeadline: boolean}> {
		const script = [
			`const {getTracer} = await import(${JSON.stringify(pathToFileURL(telemetryPath).href)});`,
			// Tracing starts asynchronously; its SIGTERM listener marks it as started.
			`while (process.listenerCount("SIGTERM") === 0) await new Promise((r) => setTimeout(r, 10));`,
			`getTracer("signal-test").startSpan("pending").end();`,
			`setInterval(() => {}, 1000);`,
			`process.stdout.write("ready\\n");`,
		].join("\n");
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: {
				...process.env,
				WIP_TRACING: "true",
				OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: await closedPortUrl(),
				OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "300",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await new Promise<void>((resolve, reject) => {
			child.stdout.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("ready")) resolve();
			});
			child.once("exit", (code) => {
				reject(new Error(`child exited early with code ${String(code)}`));
			});
		});
		const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => {
			child.once("exit", (code, exitSignal) => {
				resolve({code, signal: exitSignal});
			});
		});
		child.kill(signal);
		const deadline = new Promise<"timeout">((resolve) => {
			setTimeout(() => {
				resolve("timeout");
			}, 3000);
		});
		const result = await Promise.race([exited, deadline]);
		if (result === "timeout") {
			child.kill("SIGKILL");
			return {code: null, signal: null, withinDeadline: false};
		}
		return {...result, withinDeadline: true};
	}

	it("exits with code 143 on SIGTERM", async () => {
		expect(await exitAfterSignal("SIGTERM")).toStrictEqual({code: 143, signal: null, withinDeadline: true});
	});

	it("exits with code 130 on SIGINT", async () => {
		expect(await exitAfterSignal("SIGINT")).toStrictEqual({code: 130, signal: null, withinDeadline: true});
	});
});
