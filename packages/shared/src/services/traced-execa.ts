import {ExecaError, execa, type Options} from "execa";
import {SpanStatusCode} from "@opentelemetry/api";

import {withSubprocessSlot} from "./subprocess-gate.js";
import {getTracer} from "./telemetry.js";

export interface ExecaResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	failed: boolean;
	command: string;
}

export async function tracedExeca(command: string, args: string[], options?: Options): Promise<ExecaResult> {
	// The slot is taken before the span starts, so subprocess.duration_ms measures the run, not the wait.
	return withSubprocessSlot(async () => runTraced(command, args, options));
}

async function runTraced(command: string, args: string[], options?: Options): Promise<ExecaResult> {
	const tracer = getTracer();
	return tracer.startActiveSpan(`subprocess: ${command}`, async (span) => {
		span.setAttributes({
			"subprocess.command": command,
			"subprocess.args": args.join(" "),
		});

		const start = performance.now();
		try {
			const result = await execa(command, args, options);
			const duration = Math.round(performance.now() - start);
			span.setAttributes({
				"subprocess.exit_code": result.exitCode,
				"subprocess.duration_ms": duration,
			});
			return {
				stdout: String(result.stdout ?? ""),
				stderr: String(result.stderr ?? ""),
				exitCode: result.exitCode ?? 1,
				failed: result.failed,
				command: result.command,
			};
		} catch (error) {
			const duration = Math.round(performance.now() - start);
			const exitCode = error instanceof ExecaError ? error.exitCode : undefined;
			const message = error instanceof Error ? error.message : String(error);
			span.setAttributes({
				"subprocess.exit_code": exitCode ?? -1,
				"subprocess.duration_ms": duration,
			});
			span.setStatus({code: SpanStatusCode.ERROR, message});
			throw error;
		} finally {
			span.end();
		}
	});
}
