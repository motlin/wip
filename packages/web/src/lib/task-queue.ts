import { execa } from "execa";
import {
  getCacheDir,
  getMiseEnv,
  getTestLogDir,
  invalidateChildrenCache,
  invalidatePrCache,
  recordTestResult,
  type TaskType,
} from "@wip/shared";
import { log } from "@wip/shared/services/logger-pino.js";
import type { Transition } from "@wip/shared";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

export type { TaskType };

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
const projectQueues = new Map<string, string[]>();
const runningProjects = new Set<string>();
const runningProcesses = new Map<string, { kill: () => void }>();

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function statusToTransition(
  status: TaskStatus,
  taskType: TaskType = "test",
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

function processQueue(project: string): void {
  if (runningProjects.has(project)) return;

  const queue = projectQueues.get(project);
  if (!queue || queue.length === 0) return;

  const taskId = queue[0];
  if (!taskId) return;
  const task = tasks.get(taskId);
  if (!task) {
    queue.shift();
    return;
  }

  runningProjects.add(project);
  task.status = "running";
  task.startedAt = Date.now();
  emit(task);

  runTask(task)
    .then(() => {
      queue.shift();
      runningProjects.delete(project);
      processQueue(project);
    })
    .catch((err) => {
      task.status = "failed";
      task.message = `${task.shortSha} failed: ${err instanceof Error ? err.message : "unknown error"}`;
      task.finishedAt = Date.now();
      emit(task);
      queue.shift();
      runningProjects.delete(project);
      processQueue(project);
    });
}

async function runTask(task: Task): Promise<void> {
  switch (task.taskType) {
    case "test":
      return runTestTask(task);
    case "claude":
      return runClaudeTask(task);
    case "push":
      return runPushTask(task);
    default:
      throw new Error(`Task type "${task.taskType}" is not yet implemented`);
  }
}

interface RunProcessOptions {
  task: Task;
  cmd: string;
  args: string[];
  logDir: string;
  env?: Record<string, string>;
  cwd?: string;
}

async function runProcess({
  task,
  cmd,
  args,
  logDir,
  env,
  cwd,
}: RunProcessOptions): Promise<{ exitCode: number | undefined; duration: number } | undefined> {
  fs.mkdirSync(logDir, { recursive: true });

  const start = performance.now();
  const childProcess = execa(cmd, args, {
    reject: false,
    env: { ...env, FORCE_COLOR: "1", CLICOLOR_FORCE: "1" },
    cwd,
    buffer: true,
  });
  runningProcesses.set(task.id, { kill: () => childProcess.kill("SIGTERM") });

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
  runningProcesses.delete(task.id);

  if (task.status === "cancelled") return undefined;

  const duration = Math.round(performance.now() - start);
  log.subprocess.debug({ cmd, args, duration }, `${cmd} ${args.join(" ")} (${duration}ms)`);

  const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const logPath = path.join(logDir, `${task.sha}.log`);
  fs.writeFileSync(logPath, logContent + "\n");

  return { exitCode: result.exitCode, duration };
}

async function runTestTask(task: Task): Promise<void> {
  const miseEnv = await getMiseEnv(task.projectDir);
  const args = ["-C", task.projectDir, "test", "run", "--retest", task.sha];

  const result = await runProcess({
    task,
    cmd: "git",
    args,
    logDir: getTestLogDir(task.project),
    env: miseEnv,
  });
  if (!result) return;

  task.finishedAt = Date.now();
  const status = result.exitCode === 0 ? "passed" : "failed";
  task.status = status;
  task.message =
    status === "passed"
      ? `${task.shortSha} passed`
      : `${task.shortSha} failed (exit ${result.exitCode})`;

  recordTestResult(task.sha, task.project, status, result.exitCode ?? 1, result.duration);
  emit(task);
}

async function runClaudeTask(task: Task): Promise<void> {
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

async function runPushTask(task: Task): Promise<void> {
  if (!task.branch) throw new Error("Push task requires a branch");
  if (!task.upstreamRemote) throw new Error("Push task requires upstreamRemote");

  if (task.createBranch) {
    const branchResult = await execa(
      "git",
      ["-C", task.projectDir, "branch", task.branch, task.sha],
      { reject: false },
    );
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
    args: [
      "-C",
      task.projectDir,
      "push",
      "-u",
      task.upstreamRemote,
      `${task.branch}:refs/heads/${task.branch}`,
    ],
    logDir: path.join(getCacheDir(), "push-logs", task.project),
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

  const id = String(nextId++);
  const task: Task = {
    id,
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
  };

  tasks.set(id, task);
  if (!projectQueues.has(project)) {
    projectQueues.set(project, []);
  }
  projectQueues.get(project)!.push(id);

  emit(task);
  processQueue(project);
  return task;
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

  const id = String(nextId++);
  const now = Date.now();
  const task: Task = {
    id,
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
    status: "running",
    queuedAt: now,
  };

  tasks.set(id, task);
  if (!projectQueues.has(opts.project)) {
    projectQueues.set(opts.project, []);
  }
  projectQueues.get(opts.project)!.push(id);

  emit(task);

  void runPushTask(task).catch((err) => {
    task.status = "failed";
    task.message = `Push failed: ${err instanceof Error ? err.message : "unknown error"}`;
    task.finishedAt = Date.now();
    emit(task);
  });

  return task;
}

export function findTask(sha: string, project: string, taskType?: TaskType): Task | undefined {
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

export function cancelTask(id: string): { ok: boolean; message: string } {
  const task = tasks.get(id);
  if (!task) return { ok: false, message: "Task not found" };
  if (task.status === "passed" || task.status === "failed" || task.status === "cancelled") {
    return { ok: false, message: `Task already ${task.status}` };
  }

  if (task.status === "queued") {
    const queue = projectQueues.get(task.project);
    if (queue) {
      const idx = queue.indexOf(id);
      if (idx !== -1) queue.splice(idx, 1);
    }
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.message = `${task.shortSha} cancelled`;
    emit(task);
    return { ok: true, message: task.message };
  }

  if (task.status === "running") {
    const proc = runningProcesses.get(id);
    if (proc) {
      proc.kill();
      runningProcesses.delete(id);
    }
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.message = `${task.shortSha} cancelled`;
    emit(task);
    return { ok: true, message: task.message };
  }

  return { ok: false, message: "Unknown task status" };
}

// Backward-compatible aliases for test-specific callers
export type JobStatus = TaskStatus;
export type TestJob = Task;
export type JobEvent = TaskEvent;
export const enqueueTest = (
  project: string,
  projectDir: string,
  sha: string,
  shortSha: string,
  subject?: string,
  branch?: string,
) => enqueueTask("test", project, projectDir, sha, shortSha, subject, branch);
export const cancelTest = cancelTask;
export const findJob = (sha: string, project: string) => findTask(sha, project, "test");
export const getAllActiveJobs = getAllActiveTasks;
export const getAllJobs = getAllTasks;
