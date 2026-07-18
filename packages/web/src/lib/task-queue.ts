import {execa} from "execa";
import {
	cacheMergeStatus,
	getCacheDir,
	getCachedUpstreamSha,
	getMiseEnv,
	getTestLogDir,
	invalidateChildrenCache,
	invalidateMergeStatus,
	invalidatePrCache,
	recordTestResult,
	type TaskType,
	type Transition,
} from "@wip/shared";
import {log} from "@wip/shared/services/logger-pino.js";
import {EventEmitter} from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import {workQueue} from "./shared-work-queue.js";
import type {JobHandle} from "./work-queue.js";

export type {TaskType};

export type TaskStatus = "queued" | "running" | "passed" | "failed" | "cancelled";

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
	status: TaskStatus;
	message?: string;
	compareUrl?: string;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface TaskEvent {
	id: string;
	taskType: TaskType;
	sha: string;
	project: string;
	shortSha: string;
	subject: string;
	branch?: string;
	status: TaskStatus;
	transition?: Transition;
	message?: string;
	compareUrl?: string;
	type?: "status" | "log";
	log?: string;
}

let nextId = 1;
const tasks = new Map<string, Task>();
const jobHandles = new Map<string, JobHandle>();

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function statusToTransition(status: TaskStatus, taskType: TaskType = "test"): Transition | undefined {
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
		}
	}
	if (taskType === "rebase") {
		switch (status) {
			case "queued":
			case "running":
				return "rebase";
		}
	}
	return undefined;
}

function emit(task: Task): void {
	const transition = statusToTransition(task.status, task.taskType);
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
			return runRebaseTask(task);
		case "push":
			return runPushTask(task, signal);
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

	const start = performance.now();
	const childProcess = execa(cmd, args, {
		reject: false,
		env: {...env, FORCE_COLOR: "1", CLICOLOR_FORCE: "1"},
		cwd,
		buffer: true,
	});
	const onAbort = () => childProcess.kill("SIGTERM");
	signal.addEventListener("abort", onAbort, {once: true});

	if (childProcess.stdout) {
		childProcess.stdout.on("data", (chunk: Buffer) => {
			emitLog(task, chunk.toString());
		});
	}
	if (childProcess.stderr) {
		childProcess.stderr.on("data", (chunk: Buffer) => {
			emitLog(task, chunk.toString());
		});
	}

	const result = await childProcess;
	signal.removeEventListener("abort", onAbort);

	if (task.status === "cancelled") return undefined;

	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd, args, duration}, `${cmd} ${args.join(" ")} (${duration}ms)`);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
	const logPath = path.join(logDir, `${task.sha}.log`);
	fs.writeFileSync(logPath, logContent + "\n");

	return {exitCode: result.exitCode, duration};
}

async function runTestTask(task: Task, signal: AbortSignal): Promise<void> {
	const miseEnv = await getMiseEnv(task.projectDir);
	const args = ["-C", task.projectDir, "test", "run", "--retest", task.sha];

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

	recordTestResult(task.sha, task.project, status, result.exitCode ?? 1, result.duration);
	emit(task);
}

async function runClaudeTask(task: Task, signal: AbortSignal): Promise<void> {
	if (!task.command) throw new Error("Claude task requires a command");
	if (!task.branch) throw new Error("Claude task requires a branch");

	const checkoutResult = await execa("git", ["-C", task.projectDir, "checkout", task.branch], {
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

async function runRebaseTask(task: Task): Promise<void> {
	if (!task.branch) throw new Error("Rebase task requires a branch");
	if (!task.upstreamRef) throw new Error("Rebase task requires upstreamRef");

	const env = await getMiseEnv(task.projectDir);
	const logDir = path.join(getCacheDir(), "rebase-logs", task.project);
	fs.mkdirSync(logDir, {recursive: true});
	const captured: string[] = [];

	const run = async (args: string[]) => {
		const result = await execa("git", ["-C", task.projectDir, ...args], {reject: false, env});
		const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (out) {
			emitLog(task, out + "\n");
			captured.push(out);
		}
		return result;
	};

	const finish = (status: TaskStatus, message: string): void => {
		fs.writeFileSync(path.join(logDir, `${task.sha}.log`), captured.join("\n") + "\n");
		task.status = status;
		task.message = message;
		task.finishedAt = Date.now();
		emit(task);
	};

	if (task.upstreamRemote) {
		await run(["fetch", task.upstreamRemote]);
	}

	const checkout = await run(["checkout", task.branch]);
	if (checkout.exitCode !== 0) {
		finish("failed", `Failed to checkout ${task.branch}`);
		return;
	}

	const branchSha = (
		await execa("git", ["-C", task.projectDir, "rev-parse", "HEAD"], {reject: false, env})
	).stdout.trim();

	const rebase = await run(["rebase", "--rebase-merges", "--update-refs", task.upstreamRef]);
	if (rebase.exitCode !== 0) {
		await run(["rebase", "--abort"]);
		const upstreamSha = getCachedUpstreamSha(task.project);
		if (upstreamSha && branchSha) {
			cacheMergeStatus(task.project, branchSha, upstreamSha, 0, 1, false);
		}
		if (task.upstreamBranch) await run(["checkout", task.upstreamBranch]);
		finish("failed", `${task.branch}: rebase conflicts`);
		return;
	}

	// Push to the branch's own configured remote — NOT task.remote (a GitHub slug
	// like "owner/repo", not a git remote name) and NOT necessarily upstreamRemote
	// (a fork's branches may track "origin" while it rebases onto "upstream").
	const branchRemote =
		(
			await execa("git", ["-C", task.projectDir, "config", `branch.${task.branch}.remote`], {
				reject: false,
			})
		).stdout.trim() || "origin";
	const push = await run(["push", branchRemote, `${task.branch}:${task.branch}`, "--force-with-lease"]);
	if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
		if (task.upstreamBranch) await run(["checkout", task.upstreamBranch]);
		finish("failed", `${task.branch}: rebased but push failed`);
		return;
	}

	invalidatePrCache(task.project);
	invalidateChildrenCache(task.project);
	invalidateMergeStatus(task.project);

	if (task.upstreamBranch) await run(["checkout", task.upstreamBranch]);
	finish("passed", `Rebased ${task.branch} onto ${task.upstreamRef}`);
}

async function runPushTask(task: Task, signal: AbortSignal): Promise<void> {
	if (!task.branch) throw new Error("Push task requires a branch");
	if (!task.upstreamRemote) throw new Error("Push task requires upstreamRemote");

	if (task.createBranch) {
		const branchResult = await execa("git", ["-C", task.projectDir, "branch", task.branch, task.sha], {
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

function registerTask(task: Task): Task {
	tasks.set(task.id, task);
	emit(task);

	const handle = workQueue.enqueue({
		coalesceKey: `task:${task.taskType}:${task.project}:${task.sha}`,
		// Push gets a unique lane so it never waits behind a long test; every
		// other type shares one lane per project, preserving the old per-project
		// serial queue (a test and a rebase must not touch the same repo at once).
		laneKey: task.taskType === "push" ? `push:${task.project}:${task.sha}` : `task:${task.project}`,
		kind: task.taskType,
		project: task.project,
		// Tasks are user clicks; they jump ahead of queued background refreshes.
		priority: "foreground",
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
): Task {
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

function findTask(sha: string, project: string, taskType?: TaskType): Task | undefined {
	for (const task of tasks.values()) {
		if (task.sha === sha && task.project === project) {
			if (taskType === undefined || task.taskType === taskType) return task;
		}
	}
	return undefined;
}

export function getAllActiveTasks(): Task[] {
	return Array.from(tasks.values()).filter((t) => t.status === "queued" || t.status === "running");
}

export function getAllTasks(): Map<string, Task> {
	return tasks;
}

function cancelTask(id: string): {ok: boolean; message: string} {
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
) => enqueueTask("test", project, projectDir, sha, shortSha, subject, branch);
export const cancelTest = cancelTask;
export const getAllJobs = getAllTasks;

export async function resetQueue(): Promise<void> {
	const settled = [...jobHandles.values()].map((handle) => handle.settled);
	for (const task of tasks.values()) {
		if (task.status === "queued" || task.status === "running") {
			cancelTask(task.id);
		}
	}
	await Promise.allSettled(settled);
	tasks.clear();
	jobHandles.clear();
	nextId = 1;
}
