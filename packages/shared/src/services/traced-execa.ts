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

export interface TreeKillOptions {
	/**
	 * Aborting it kills the subprocess and everything it started: the child runs as its own process
	 * group leader and the whole group gets SIGTERM (a `git test run` spawns test runners and workers).
	 */
	killTreeOn?: AbortSignal;
}

export async function tracedExeca(
	command: string,
	args: string[],
	options?: Options,
	tree?: TreeKillOptions,
): Promise<ExecaResult> {
	// The slot is taken before the span starts, so subprocess.duration_ms measures the run, not the wait.
	return withSubprocessSlot(async () => runTraced(command, args, options, tree?.killTreeOn));
}

/** Starts the subprocess, as a process group leader whose group dies with `killTreeOn` when given. */
async function runSubprocess(command: string, args: string[], options: Options | undefined, killTreeOn?: AbortSignal) {
	if (killTreeOn === undefined) return execa(command, args, options);
	const subprocess = execa(command, args, {...options, detached: true});
	const killTree = (): void => {
		const {pid} = subprocess;
		if (pid === undefined) return;
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// The group already exited.
		}
	};
	if (killTreeOn.aborted) killTree();
	killTreeOn.addEventListener("abort", killTree, {once: true});
	try {
		return await subprocess;
	} finally {
		killTreeOn.removeEventListener("abort", killTree);
	}
}

async function runTraced(
	command: string,
	args: string[],
	options?: Options,
	killTreeOn?: AbortSignal,
): Promise<ExecaResult> {
	const tracer = getTracer();
	return tracer.startActiveSpan(`subprocess: ${command}`, async (span) => {
		span.setAttributes({
			"subprocess.command": command,
			"subprocess.args": args.join(" "),
		});

		const start = performance.now();
		try {
			const result = await runSubprocess(command, args, options, killTreeOn);
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
