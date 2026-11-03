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

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// The group already exited.
	}
}

/**
 * Detached groups still running. A detached child leads its own session, so a Ctrl-C or a process
 * manager stopping the server never reaches it and execa's cleanup skips it; the server kills them itself.
 */
const liveGroups = new Set<number>();
const SHUTDOWN_SIGNALS = {SIGINT: 2, SIGTERM: 15} as const;
let shutdownHooksInstalled = false;

function killLiveGroups(): void {
	for (const pid of liveGroups) killGroup(pid);
	liveGroups.clear();
}

// Listening for a signal disables Node's default exit on it. The handler is prepended so it runs
// before any other listener (telemetry's flush), and exits only when no other listener remains to do so.
function installShutdownHooks(): void {
	if (shutdownHooksInstalled) return;
	shutdownHooksInstalled = true;
	process.once("exit", killLiveGroups);
	for (const [signal, number] of Object.entries(SHUTDOWN_SIGNALS)) {
		process.prependOnceListener(signal, () => {
			killLiveGroups();
			if (process.listenerCount(signal) === 0) process.exit(128 + number);
		});
	}
}

/**
 * Starts the subprocess as a process group leader whose whole group dies with `killTreeOn` or server
 * shutdown. Hands back the subprocess unawaited, so callers can stream its output.
 */
export function execaTree<O extends Options>(
	command: string,
	args: string[],
	options: O,
	killTreeOn: AbortSignal,
): {subprocess: ReturnType<typeof execa<O & {detached: true}>>} {
	installShutdownHooks();
	const subprocess = execa(command, args, {...options, detached: true});
	const {pid} = subprocess;
	const killTree = (): void => {
		if (pid !== undefined) killGroup(pid);
	};
	if (pid !== undefined) liveGroups.add(pid);
	if (killTreeOn.aborted) killTree();
	killTreeOn.addEventListener("abort", killTree, {once: true});
	const release = (): void => {
		killTreeOn.removeEventListener("abort", killTree);
		if (pid !== undefined) liveGroups.delete(pid);
	};
	void subprocess.then(release, release);
	return {subprocess};
}

async function runSubprocess(command: string, args: string[], options: Options | undefined, killTreeOn?: AbortSignal) {
	if (killTreeOn === undefined) return execa(command, args, options);
	return execaTree(command, args, options ?? {}, killTreeOn).subprocess;
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
