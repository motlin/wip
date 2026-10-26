import {execa} from "execa";
import {
	getCacheDir,
	getMiseEnv,
	getTestLogDir,
	invalidateChildrenCache,
	invalidateMergeStatus,
	invalidatePrCache,
	loadRecentTaskRecords,
	rebaseBranchOntoUpstream,
	runLadder,
	upsertTaskRecord,
	TaskTypeSchema,
	LadderResultSchema,
	type CostClass,
	type LadderResult,
	type LadderRunProject,
	type LadderTestFix,
	type RunLadderOptions,
	type TaskType,
	type TransitionOutcome,
	type Transition,
} from "@wip/shared";
import {log} from "@wip/shared/services/logger-pino.js";
import {withSubprocessSlot} from "@wip/shared/services/subprocess-gate.js";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {EventEmitter} from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type {Category} from "@wip/shared/schemas.js";
import {probeHerdr} from "./herdr/availability.js";
import {runAiConflictRung, runAiTestFixLoop, type AiRungDeps} from "./herdr/ai-rungs.js";
import {stageRank} from "./stage-rank.js";
import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";
import type {JobHandle} from "./work-queue.js";

import type {TaskEvent, TaskStatus} from "./server-events-schema.js";

export type {TaskType};

export type {TaskEvent, TaskStatus};

export interface Task {
	id: string;
	taskType: TaskType;
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	branch?: string;
	command?: string;
	upstreamRemote?: string;
	upstreamRef?: string;
	upstreamBranch?: string;
	remote?: string;
	createBranch?: boolean;
	/** Test tasks: re-run a cached bad result. Only for an explicit Run Test on a test_failed item. */
	retest?: boolean;
	status: TaskStatus;
	message?: string;
	outcome?: TransitionOutcome;
	compareUrl?: string;
	/** Ladder tasks: the typed result, persisted as JSON in the task record's outcome column. */
	ladderResult?: LadderResult;
	ladderProject?: LadderTaskProject;
	/** Ladder tasks: override the rung implementations (tests). */
	ladderRunners?: RunLadderOptions["runners"];
	/** Ladder tasks: AI follow-up wiring; absent means no AI rung. */
	ladderAi?: LadderAiOptions;
	/** Ladder tasks: true while the AI follow-up is still running after the ladder job settled. */
	aiPending?: boolean;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface LadderAiOptions {
	/** Whether herdr is reachable (defaults to probing the herdr socket). */
	probe?: () => Promise<boolean>;
	/** Overrides for the AI conflict rung dependencies (tests). */
	overrides?: Partial<AiRungDeps>;
}

export interface LadderTaskProject {
	upstreamRemote: string;
	upstreamBranch: string;
	dirty: boolean;
	detached: boolean;
	rebaseInProgress: boolean;
}

let nextId = 1;
const tasks = new Map<string, Task>();
const jobHandles = new Map<string, JobHandle>();
// Settles when a task's job and any follow-up it chains (the ladder's AI rung) have finished.
const taskCompletions = new Map<string, Promise<void>>();

// The registry keeps finished tasks so the Tasks page can show history, but a
// long-lived server enqueues forever — retain only the most recent terminal
// tasks; queued/running tasks are never dropped.
const TERMINAL_TASK_RETENTION = 200;

export function pruneTerminalTasks(registry: Map<string, Task>, keep: number): void {
	const terminal = [...registry.values()].filter(
		(task) => task.status === "passed" || task.status === "failed" || task.status === "cancelled",
	);
	if (terminal.length <= keep) return;
	terminal.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
	for (const task of terminal.slice(0, terminal.length - keep)) {
		registry.delete(task.id);
	}
}

function persistTask(task: Task): void {
	upsertTaskRecord({
		id: task.id,
		kind: task.taskType,
		project: task.project,
		sha: task.sha,
		status: task.status,
		outcome: task.ladderResult ? JSON.stringify(task.ladderResult) : (task.outcome ?? null),
		createdAt: new Date(task.queuedAt).toISOString(),
		finishedAt: task.finishedAt === undefined ? null : new Date(task.finishedAt).toISOString(),
		error: task.message ?? null,
	});
}

function parseLadderResult(outcome: string | null): LadderResult | undefined {
	if (outcome === null) return undefined;
	try {
		return LadderResultSchema.parse(JSON.parse(outcome));
	} catch {
		return undefined;
	}
}

// Only the persisted columns survive a restart, so reloaded tasks carry a
// short sha as their subject and no project directory. Their process died
// with the server, so anything queued or running is loaded as cancelled.
function loadPersistedTasks(): void {
	const records = loadRecentTaskRecords();
	let maxId = 0;
	for (const record of records) {
		const parsedType = TaskTypeSchema.safeParse(record.kind);
		if (!parsedType.success) continue;
		const stale = record.status === "queued" || record.status === "running";
		const shortSha = record.sha.slice(0, 7);
		const ladderResult = parsedType.data === "ladder" ? parseLadderResult(record.outcome) : undefined;
		const task: Task = {
			id: record.id,
			taskType: parsedType.data,
			project: record.project,
			projectDir: "",
			sha: record.sha,
			shortSha,
			subject: shortSha,
			status: stale ? "cancelled" : record.status,
			message: stale ? `${shortSha} cancelled by server restart` : (record.error ?? undefined),
			outcome: record.outcome === "conflicts" ? "conflicts" : undefined,
			ladderResult,
			queuedAt: Date.parse(record.createdAt),
			finishedAt: record.finishedAt === null ? undefined : Date.parse(record.finishedAt),
		};
		if (stale) {
			task.finishedAt = Date.now();
			persistTask(task);
		}
		tasks.set(task.id, task);
		const numericId = Number(task.id);
		if (Number.isInteger(numericId) && numericId > maxId) maxId = numericId;
	}
	nextId = Math.max(nextId, maxId + 1);
}

let loaded = false;

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	loadPersistedTasks();
}

// Replaces the in-memory registry with the persisted history, as a server restart would.
export function reloadTasksFromDb(): void {
	tasks.clear();
	jobHandles.clear();
	taskCompletions.clear();
	nextId = 1;
	loaded = true;
	loadPersistedTasks();
}

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function statusToTransition(
	status: TaskStatus,
	taskType: TaskType = "test",
	outcome?: TransitionOutcome,
): Transition | undefined {
	if (taskType === "test") {
		switch (status) {
			case "queued":
			case "running":
				return "run_test";
			case "passed":
				return "test_pass";
			case "failed":
				return "test_fail";
			case "cancelled":
				return "cancel_test";
		}
	}
	if (taskType === "push") {
		switch (status) {
			case "queued":
			case "running":
				return "push";
			case "passed":
			case "failed":
			case "cancelled":
				return undefined;
		}
	}
	if (taskType === "ladder") return undefined;
	if (taskType === "rebase") {
		switch (status) {
			case "queued":
			case "running":
				return "rebase";
			case "failed":
				return outcome === "conflicts" ? "rebase" : undefined;
			case "passed":
			case "cancelled":
				return undefined;
		}
	}
	return undefined;
}

function emit(task: Task): void {
	persistTask(task);
	const transition = statusToTransition(task.status, task.taskType, task.outcome);
	const event: TaskEvent = {
		id: task.id,
		taskType: task.taskType,
		sha: task.sha,
		project: task.project,
		shortSha: task.shortSha,
		subject: task.subject,
		branch: task.branch,
		status: task.status,
		transition,
		outcome: task.outcome,
		message: task.message,
		compareUrl: task.compareUrl,
		type: "status",
	};
	emitter.emit("task", event);
}

function emitLog(task: Task, chunk: string): void {
	const event: TaskEvent = {
		id: task.id,
		taskType: task.taskType,
		sha: task.sha,
		project: task.project,
		shortSha: task.shortSha,
		subject: task.subject,
		branch: task.branch,
		status: task.status,
		type: "log",
		log: chunk,
	};
	emitter.emit("task", event);
}

async function runTask(task: Task, signal: AbortSignal): Promise<void> {
	switch (task.taskType) {
		case "test":
			return runTestTask(task, signal);
		case "claude":
			return runClaudeTask(task, signal);
		case "rebase":
			return runRebaseTask(task, signal);
		case "push":
			return runPushTask(task, signal);
		case "ladder":
			return runLadderTask(task, signal);
		default: {
			const unhandled: never = task.taskType;
			throw new Error(`Task type "${String(unhandled)}" is not yet implemented`);
		}
	}
}

interface RunProcessOptions {
	task: Task;
	cmd: string;
	args: string[];
	logDir: string;
	signal: AbortSignal;
	env?: Record<string, string>;
	cwd?: string;
}

async function runProcess({
	task,
	cmd,
	args,
	logDir,
	signal,
	env,
	cwd,
}: RunProcessOptions): Promise<{exitCode: number | undefined; duration: number} | undefined> {
	if (signal.aborted) return undefined;
	fs.mkdirSync(logDir, {recursive: true});

	// Counted against the process-wide subprocess cap like every other spawn.
	const gated = await withSubprocessSlot(async () => {
		if (signal.aborted) return undefined;
		const start = performance.now();
		const childProcess = execa(cmd, args, {
			reject: false,
			env: {...env, FORCE_COLOR: "1", CLICOLOR_FORCE: "1"},
			cwd,
			buffer: true,
		});
		const onAbort = () => childProcess.kill("SIGTERM");
		signal.addEventListener("abort", onAbort, {once: true});

		childProcess.stdout.on("data", (chunk: Buffer) => {
			emitLog(task, chunk.toString());
		});
		childProcess.stderr.on("data", (chunk: Buffer) => {
			emitLog(task, chunk.toString());
		});

		const finished = await childProcess;
		signal.removeEventListener("abort", onAbort);
		return {result: finished, start};
	});
	if (!gated) return undefined;
	const {result, start} = gated;

	if (task.status === "cancelled") return undefined;

	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd, args, duration}, `${cmd} ${args.join(" ")} (${duration}ms)`);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
	const logPath = path.join(logDir, `${task.sha}.log`);
	fs.writeFileSync(logPath, logContent + "\n");

	return {exitCode: result.exitCode, duration};
}

/** `git test run` args for a test task: a cached result is reused unless the task asks to retest. */
export function testTaskArgs(task: Pick<Task, "projectDir" | "sha" | "retest">): string[] {
	return ["-C", task.projectDir, "test", "run", ...(task.retest ? ["--retest"] : []), task.sha];
}

async function runTestTask(task: Task, signal: AbortSignal): Promise<void> {
	const miseEnv = await getMiseEnv(task.projectDir);
	const args = testTaskArgs(task);

	const result = await runProcess({
		task,
		cmd: "git",
		args,
		logDir: getTestLogDir(task.project),
		signal,
		env: miseEnv,
	});
	if (!result) return;

	task.finishedAt = Date.now();
	const status = result.exitCode === 0 ? "passed" : "failed";
	task.status = status;
	task.message =
		status === "passed" ? `${task.shortSha} passed` : `${task.shortSha} failed (exit ${result.exitCode})`;

	emit(task);
}

async function runClaudeTask(task: Task, signal: AbortSignal): Promise<void> {
	if (!task.command) throw new Error("Claude task requires a command");
	if (!task.branch) throw new Error("Claude task requires a branch");

	const checkoutResult = await tracedExeca("git", ["-C", task.projectDir, "checkout", task.branch], {
		reject: false,
	});
	if (checkoutResult.exitCode !== 0) {
		task.status = "failed";
		task.finishedAt = Date.now();
		task.message = `Failed to checkout ${task.branch}: ${checkoutResult.stderr}`;
		emit(task);
		return;
	}

	const result = await runProcess({
		task,
		cmd: "claude",
		args: ["--print", task.command],
		logDir: path.join(getCacheDir(), "claude-logs", task.project),
		signal,
		cwd: task.projectDir,
	});
	if (!result) return;

	task.finishedAt = Date.now();
	task.status = result.exitCode === 0 ? "passed" : "failed";
	task.message =
		task.status === "passed"
			? `${task.shortSha} ${task.command} completed`
			: `${task.shortSha} ${task.command} failed (exit ${result.exitCode})`;
	emit(task);
}

async function runRebaseTask(task: Task, signal: AbortSignal): Promise<void> {
	if (!task.branch) throw new Error("Rebase task requires a branch");
	if (!task.upstreamRef) throw new Error("Rebase task requires upstreamRef");

	const env = await getMiseEnv(task.projectDir);
	const logDir = path.join(getCacheDir(), "rebase-logs", task.project);
	fs.mkdirSync(logDir, {recursive: true});
	const captured: string[] = [];

	const finish = (status: TaskStatus, message: string): void => {
		fs.writeFileSync(path.join(logDir, `${task.sha}.log`), captured.join("\n") + "\n");
		task.status = status;
		task.message = message;
		task.finishedAt = Date.now();
		emit(task);
	};

	// Push-remote resolution is left to the operation's branch-config fallback —
	// NOT task.remote (a GitHub slug like "owner/repo", not a git remote name)
	// and NOT necessarily upstreamRemote (a fork's branches may track "origin"
	// while it rebases onto "upstream").
	const result = await rebaseBranchOntoUpstream(task.projectDir, {
		branch: task.branch,
		project: task.project,
		upstreamRef: task.upstreamRef,
		upstreamRemote: task.upstreamRemote,
		rebaseMerges: true,
		env,
		signal,
		onOutput: (chunk) => {
			emitLog(task, chunk + "\n");
			captured.push(chunk);
		},
	});

	// A cancelled task already reported its final status; the git work that
	// was killed or skipped must not overwrite its status. A cancel that
	// interrupted the push may still have updated the remote, so refresh caches.
	if (signal.aborted || task.status === "cancelled") {
		if (!result.ok && result.stage === "cancelled" && result.pushMayHaveLanded) {
			invalidatePrCache(task.project);
			invalidateChildrenCache(task.project);
			invalidateMergeStatus(task.project);
		}
		return;
	}

	if (!result.ok) {
		if (result.stage === "checkout") {
			finish("failed", `Failed to checkout ${task.branch}`);
		} else if (result.stage === "rebase") {
			task.outcome = "conflicts";
			finish("failed", `${task.branch}: rebase conflicts`);
		} else {
			finish("failed", `${task.branch}: rebased but push failed`);
		}
		return;
	}

	invalidatePrCache(task.project);
	invalidateChildrenCache(task.project);
	invalidateMergeStatus(task.project);

	finish("passed", result.message);
}

async function runLadderTask(task: Task, signal: AbortSignal): Promise<void> {
	const info = task.ladderProject;
	if (!info) throw new Error("Ladder task requires project info");
	const result = await runLadder(
		{
			name: task.project,
			path: task.projectDir,
			upstreamRemote: info.upstreamRemote,
			upstreamBranch: info.upstreamBranch,
			dirty: info.dirty,
			detached: info.detached,
			rebaseInProgress: info.rebaseInProgress,
			offline: false,
		},
		{signal, runners: task.ladderRunners},
	);
	if (signal.aborted || task.status === "cancelled") return;
	task.ladderResult = result;
	task.finishedAt = Date.now();
	if (result.stop) {
		const branches = result.stop.branches.length > 0 ? ` (${result.stop.branches.join(", ")})` : "";
		task.status = "failed";
		task.message = `stopped: ${result.stop.stop}${branches}`;
	} else {
		task.status = "passed";
		task.message = `${result.rungs.length} rung(s) passed`;
	}
	emit(task);
}

function ladderRunProject(task: Task, info: LadderTaskProject): LadderRunProject {
	return {
		name: task.project,
		path: task.projectDir,
		upstreamRemote: info.upstreamRemote,
		upstreamBranch: info.upstreamBranch,
		dirty: info.dirty,
		detached: info.detached,
		rebaseInProgress: info.rebaseInProgress,
		offline: false,
	};
}

function finishLadderTask(task: Task): void {
	const result = task.ladderResult;
	task.finishedAt = Date.now();
	if (result?.stop) {
		const branches = result.stop.branches.length > 0 ? ` (${result.stop.branches.join(", ")})` : "";
		task.status = "failed";
		task.message = `stopped: ${result.stop.stop}${branches}`;
	} else {
		task.status = "passed";
		task.message = `${result?.rungs.length ?? 0} rung(s) passed`;
	}
	emit(task);
}

function setTestFix(task: Task, entry: LadderTestFix): void {
	const current = task.ladderResult;
	if (!current) return;
	const others = (current.testFix ?? []).filter((e) => e.branch !== entry.branch);
	task.ladderResult = {...current, testFix: [...others, entry]};
	emit(task);
}

/** Test and fix each branch the ladder rebased, or hand the exact command to the user when herdr is unavailable. */
async function runLadderTestFix(task: Task, branches: string[]): Promise<void> {
	const ai = task.ladderAi;
	const info = task.ladderProject;
	if (!ai || !info || branches.length === 0 || !task.ladderResult) return;

	const available = await (ai.probe ?? (async () => (await probeHerdr()).available))();
	if (!available) {
		task.ladderResult = {
			...task.ladderResult,
			needsAi: {command: `cd ${task.projectDir} && claude "/build:test-branch"`},
		};
		emit(task);
		return;
	}

	const project = ladderRunProject(task, info);
	/* oxlint-disable no-await-in-loop -- one branch at a time per project */
	for (const branch of branches) {
		const done = await runAiTestFixLoop(
			project,
			branch,
			{
				...ai.overrides,
				onLaunched: (launched) => {
					if (task.ladderResult) task.ladderResult = {...task.ladderResult, herdr: launched};
					ai.overrides?.onLaunched?.(launched);
					emit(task);
				},
			},
			(progress) => {
				setTestFix(task, {branch, ...progress});
			},
		);
		setTestFix(task, {branch, ...done});
	}
	/* oxlint-enable no-await-in-loop */
	emit(task);
}

async function runLadderAiFollowUp(task: Task): Promise<void> {
	const ai = task.ladderAi;
	const info = task.ladderProject;
	const result = task.ladderResult;
	if (!ai || !info || !result) return;

	if (result.stop?.stop !== "conflict") {
		// The ladder finished or stopped for another reason; test the branches it rebased cleanly.
		if (!result.stop && task.status === "passed") await runLadderTestFix(task, result.rebased ?? []);
		return;
	}
	if (task.status !== "failed") return;

	const available = await (ai.probe ?? (async () => (await probeHerdr()).available))();
	if (!available) {
		task.ladderResult = {...result, needsAi: {command: `cd ${task.projectDir} && claude "/git:conflicts"`}};
		emit(task);
		return;
	}

	let herdr: LadderResult["herdr"];
	task.ladderResult = {...result, aiStatus: "queued"};
	emit(task);
	const next = await runAiConflictRung(ladderRunProject(task, info), result.stop, {
		...ai.overrides,
		onLaunched: (launched) => {
			herdr = launched;
			task.ladderResult = {...(task.ladderResult ?? result), herdr, aiStatus: "running"};
			emit(task);
		},
	});
	const final = next === "stuck" ? result : next;
	task.ladderResult = {
		...final,
		...(herdr ? {herdr} : {}),
		aiStatus: next === "stuck" || next.stop ? "stuck" : "done",
	};
	finishLadderTask(task);
	if (next !== "stuck" && !next.stop) {
		const resolved = [...new Set([...result.stop.branches, ...(next.rebased ?? [])])];
		await runLadderTestFix(task, resolved);
	}
}

async function runPushTask(task: Task, signal: AbortSignal): Promise<void> {
	if (!task.branch) throw new Error("Push task requires a branch");
	if (!task.upstreamRemote) throw new Error("Push task requires upstreamRemote");

	if (task.createBranch) {
		const branchResult = await tracedExeca("git", ["-C", task.projectDir, "branch", task.branch, task.sha], {
			reject: false,
		});
		if (branchResult.exitCode !== 0) {
			task.status = "failed";
			task.message = `Failed to create branch: ${branchResult.stderr}`;
			task.finishedAt = Date.now();
			emit(task);
			return;
		}
		emitLog(task, `Created branch ${task.branch}\n`);
	}

	const result = await runProcess({
		task,
		cmd: "git",
		args: ["-C", task.projectDir, "push", "-u", task.upstreamRemote, `${task.branch}:refs/heads/${task.branch}`],
		logDir: path.join(getCacheDir(), "push-logs", task.project),
		signal,
	});
	if (!result) return;

	task.finishedAt = Date.now();
	if (result.exitCode === 0) {
		invalidatePrCache(task.project);
		invalidateChildrenCache(task.project);
		task.status = "passed";
		task.message = `Pushed ${task.shortSha} to ${task.branch}`;
		if (task.remote) {
			task.compareUrl = `https://github.com/${task.remote}/compare/${task.branch}?expand=1`;
		}
	} else {
		task.status = "failed";
		task.message = `Failed to push ${task.branch}`;
	}
	emit(task);
}

// The category a task's commit is in when the task is enqueued; closest to pushed runs first.
const TASK_STAGE: Record<TaskType, Category> = {
	push: "ready_to_push",
	test: "ready_to_test",
	rebase: "needs_rebase",
	claude: "ready_to_test",
	ladder: "needs_rebase",
};

const TASK_COST_CLASS: Record<TaskType, CostClass> = {
	test: "build",
	claude: "ai",
	rebase: "git-write",
	push: "git-write",
	ladder: "git-write",
};

function registerTask(task: Task): Task {
	pruneTerminalTasks(tasks, TERMINAL_TASK_RETENTION);
	tasks.set(task.id, task);
	emit(task);

	const handle = workQueue.enqueue({
		coalesceKey: `task:${task.taskType}:${task.project}:${task.sha}`,
		// Every type, push included, holds the shared per-repo resource, so a test,
		// a rebase, a push and a refresh never touch the same repo at once.
		resources: [repoResource(task.project)],
		kind: task.taskType,
		project: task.project,
		costClass: TASK_COST_CLASS[task.taskType],
		rank: stageRank(TASK_STAGE[task.taskType]),
		// Tasks are user clicks and jump ahead of queued background refreshes; ladder sweeps stay background.
		priority: task.taskType === "ladder" ? "background" : "foreground",
		run: async (signal) => {
			if (task.status === "cancelled") return;
			task.status = "running";
			task.startedAt = Date.now();
			emit(task);
			try {
				await runTask(task, signal);
			} catch (err) {
				task.status = "failed";
				task.message = `${task.shortSha} failed: ${err instanceof Error ? err.message : "unknown error"}`;
				task.finishedAt = Date.now();
				emit(task);
			}
		},
	});
	jobHandles.set(task.id, handle);
	void handle.settled.finally(() => jobHandles.delete(task.id));
	let completion = handle.settled;
	if (task.taskType === "ladder" && task.ladderAi) {
		task.aiPending = true;
		// The ladder job holds the repo resource, so the AI job can only be enqueued after it settles.
		completion = completion.then(async () => runLadderAiFollowUp(task)).finally(() => (task.aiPending = false));
	}
	taskCompletions.set(task.id, completion);
	void completion.finally(() => {
		if (taskCompletions.get(task.id) === completion) taskCompletions.delete(task.id);
	});

	return task;
}

export function enqueueTask(
	taskType: TaskType,
	project: string,
	projectDir: string,
	sha: string,
	shortSha: string,
	subject?: string,
	branch?: string,
	command?: string,
	retest?: boolean,
): Task {
	ensureLoaded();
	const existing = findTask(sha, project, taskType);
	if (existing && (existing.status === "queued" || existing.status === "running")) {
		return existing;
	}

	return registerTask({
		id: String(nextId++),
		taskType,
		project,
		projectDir,
		sha,
		shortSha,
		subject: subject ?? shortSha,
		branch,
		command,
		...(retest ? {retest} : {}),
		status: "queued",
		queuedAt: Date.now(),
	});
}

export interface EnqueuePushOptions {
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	branch: string;
	upstreamRemote: string;
	remote: string;
	createBranch: boolean;
}

export function enqueuePush(opts: EnqueuePushOptions): Task {
	ensureLoaded();
	const existing = findTask(opts.sha, opts.project, "push");
	if (existing && (existing.status === "queued" || existing.status === "running")) {
		return existing;
	}

	return registerTask({
		id: String(nextId++),
		taskType: "push",
		project: opts.project,
		projectDir: opts.projectDir,
		sha: opts.sha,
		shortSha: opts.shortSha,
		subject: opts.subject,
		branch: opts.branch,
		upstreamRemote: opts.upstreamRemote,
		remote: opts.remote,
		createBranch: opts.createBranch,
		status: "queued",
		queuedAt: Date.now(),
	});
}

export interface EnqueueRebaseOptions {
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	branch: string;
	upstreamRemote: string;
	upstreamRef: string;
	upstreamBranch?: string;
	remote: string;
}

export function enqueueRebase(opts: EnqueueRebaseOptions): Task {
	ensureLoaded();
	const existing = findTask(opts.sha, opts.project, "rebase");
	if (existing && (existing.status === "queued" || existing.status === "running")) {
		return existing;
	}

	return registerTask({
		id: String(nextId++),
		taskType: "rebase",
		project: opts.project,
		projectDir: opts.projectDir,
		sha: opts.sha,
		shortSha: opts.shortSha,
		subject: opts.subject,
		branch: opts.branch,
		upstreamRemote: opts.upstreamRemote,
		upstreamRef: opts.upstreamRef,
		upstreamBranch: opts.upstreamBranch,
		remote: opts.remote,
		status: "queued",
		queuedAt: Date.now(),
	});
}

export interface EnqueueLadderOptions extends LadderTaskProject {
	project: string;
	projectDir: string;
	runners?: RunLadderOptions["runners"];
	ai?: LadderAiOptions;
}

export function enqueueLadder(opts: EnqueueLadderOptions): Task {
	ensureLoaded();
	const existing = findTask("", opts.project, "ladder");
	if (existing && (existing.status === "queued" || existing.status === "running")) {
		return existing;
	}

	return registerTask({
		id: String(nextId++),
		taskType: "ladder",
		project: opts.project,
		projectDir: opts.projectDir,
		sha: "",
		shortSha: "",
		subject: "ladder",
		ladderProject: {
			upstreamRemote: opts.upstreamRemote,
			upstreamBranch: opts.upstreamBranch,
			dirty: opts.dirty,
			detached: opts.detached,
			rebaseInProgress: opts.rebaseInProgress,
		},
		ladderRunners: opts.runners,
		ladderAi: opts.ai,
		status: "queued",
		queuedAt: Date.now(),
	});
}

/** The most recent finished ladder result per project, including ones reloaded from the database. */
export function getLatestLadderResults(): LadderResult[] {
	ensureLoaded();
	const latest = new Map<string, Task>();
	for (const task of tasks.values()) {
		if (task.taskType !== "ladder" || !task.ladderResult) continue;
		const current = latest.get(task.project);
		if (!current || (task.finishedAt ?? 0) >= (current.finishedAt ?? 0)) latest.set(task.project, task);
	}
	return [...latest.values()].flatMap((t) => (t.ladderResult ? [t.ladderResult] : []));
}

function findTask(sha: string, project: string, taskType?: TaskType): Task | undefined {
	for (const task of tasks.values()) {
		if (task.sha === sha && task.project === project) {
			if (taskType === undefined || task.taskType === taskType) return task;
		}
	}
	return undefined;
}

export function getAllActiveTasks(): Task[] {
	ensureLoaded();
	return Array.from(tasks.values()).filter((t) => t.status === "queued" || t.status === "running");
}

export function getAllTasks(): Map<string, Task> {
	ensureLoaded();
	return tasks;
}

function cancelTask(id: string): {ok: boolean; message: string} {
	ensureLoaded();
	const task = tasks.get(id);
	if (!task) return {ok: false, message: "Task not found"};
	if (task.status === "passed" || task.status === "failed" || task.status === "cancelled") {
		return {ok: false, message: `Task already ${task.status}`};
	}

	// One cancel path for both cases: the queue drops the job if it is still
	// queued, or aborts its signal if it is running (runProcess kills the child).
	task.status = "cancelled";
	task.finishedAt = Date.now();
	task.message = `${task.shortSha} cancelled`;
	jobHandles.get(id)?.cancel();
	emit(task);
	return {ok: true, message: task.message};
}

export const enqueueTest = (
	project: string,
	projectDir: string,
	sha: string,
	shortSha: string,
	subject?: string,
	branch?: string,
	opts?: {retest?: boolean},
): Task => enqueueTask("test", project, projectDir, sha, shortSha, subject, branch, undefined, opts?.retest);
export const cancelTest = cancelTask;
export const getAllJobs = getAllTasks;

/** Resolves once the task's job and any follow-up it chains have finished; immediately if none is in flight. */
export async function waitForTask(id: string): Promise<void> {
	await taskCompletions.get(id);
}

export async function resetQueue(): Promise<void> {
	// Each completion covers its job's settle plus any chained follow-up.
	const settled = [...taskCompletions.values()];
	for (const task of tasks.values()) {
		if (task.status === "queued" || task.status === "running") {
			cancelTask(task.id);
		}
	}
	await Promise.allSettled(settled);
	tasks.clear();
	jobHandles.clear();
	taskCompletions.clear();
	nextId = 1;
	loaded = false;
}
