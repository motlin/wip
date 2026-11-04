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

/** A subprocess that exited non-zero (or never started), as a failed action's log shows it. */
export interface SubprocessFailure {
	command: string;
	exitCode: number;
	stderr: string;
}

type SubprocessFailureListener = (failure: SubprocessFailure) => void;
const failureListeners = new Set<SubprocessFailureListener>();

/** Hears every failing subprocess, whether or not logging is on, so an action keeps the command that failed it. */
export function subscribeSubprocessFailures(listener: SubprocessFailureListener): void {
	failureListeners.add(listener);
}

export function unsubscribeSubprocessFailures(listener: SubprocessFailureListener): void {
	failureListeners.delete(listener);
}

/** The git subcommand and its own args, past global options such as `-C dir` and `-c key=value`. */
function gitSubcommand(args: readonly string[]): {name: string; rest: readonly string[]} | undefined {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg === "-C" || arg === "-c") i += 2;
		else if (arg?.startsWith("-") === true) i += 1;
		else break;
	}
	const name = args[i];
	return name === undefined ? undefined : {name, rest: args.slice(i + 1)};
}

/**
 * True when a git probe exited with the code that answers its question ("not an ancestor", "no such
 * ref", "differs", "conflicts"): the caller handles that exit, so it is not the command that failed an action.
 */
export function isExpectedProbeExit(command: string, args: readonly string[], exitCode: number): boolean {
	if (command !== "git") return false;
	const sub = gitSubcommand(args);
	if (sub === undefined) return false;
	const has = (...flags: string[]): boolean => flags.some((flag) => sub.rest.includes(flag));
	switch (sub.name) {
		case "merge-base":
			return has("--is-ancestor") && exitCode === 1;
		case "rev-parse":
			// Without --quiet a missing ref exits 128 ("Needed a single revision").
			return has("--verify") && (exitCode === 1 || exitCode === 128);
		case "show-ref":
			return exitCode === 1 || (has("--exists") && exitCode === 2);
		case "diff":
			return has("--quiet", "--exit-code") && exitCode === 1;
		case "symbolic-ref":
			return has("--quiet", "-q") && exitCode === 1;
		case "merge-tree":
			return has("--write-tree") && exitCode === 1;
		case "config":
			return has("--get", "--get-all", "--get-regexp") && exitCode === 1;
		case "ls-remote":
			return has("--exit-code") && exitCode === 2;
		case "cat-file":
			return has("-e") && exitCode === 1;
		default:
			return false;
	}
}

function reportFailure(failure: SubprocessFailure): void {
	for (const listener of failureListeners) {
		try {
			listener(failure);
		} catch {
			// a failing listener must not break the subprocess call
		}
	}
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
			const finished = {
				stdout: String(result.stdout ?? ""),
				stderr: String(result.stderr ?? ""),
				exitCode: result.exitCode ?? 1,
				failed: result.failed,
				command: result.command,
			};
			if (finished.exitCode !== 0 && !isExpectedProbeExit(command, args, finished.exitCode)) {
				reportFailure({command: result.escapedCommand, exitCode: finished.exitCode, stderr: finished.stderr});
			}
			return finished;
		} catch (error) {
			const duration = Math.round(performance.now() - start);
			const exitCode = error instanceof ExecaError ? error.exitCode : undefined;
			const message = error instanceof Error ? error.message : String(error);
			span.setAttributes({
				"subprocess.exit_code": exitCode ?? -1,
				"subprocess.duration_ms": duration,
			});
			span.setStatus({code: SpanStatusCode.ERROR, message});
			const stderr: unknown = error instanceof ExecaError ? error.stderr : undefined;
			if (exitCode === undefined || !isExpectedProbeExit(command, args, exitCode))
				reportFailure({
					command: error instanceof ExecaError ? error.escapedCommand : [command, ...args].join(" "),
					exitCode: exitCode ?? -1,
					stderr: typeof stderr === "string" ? stderr : message,
				});
			throw error;
		} finally {
			span.end();
		}
	});
}
