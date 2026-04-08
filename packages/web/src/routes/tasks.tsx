import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { testAllChildren, cancelTestFn, pushChild } from "../lib/server-fns";
import type { TaskQueueJob, TaskType } from "@wip/shared";
import { useTaskEvents, type TaskEvent } from "../lib/use-task-events";
import { useHasActiveTests } from "../lib/task-events-context";
import {
  Clock,
  Play,
  CheckCircle,
  XCircle,
  Loader2,
  Ban,
  X,
  FileText,
  ArrowUpRight,
  GitBranch,
  FlaskConical,
  Bot,
  GitMerge,
} from "lucide-react";
import { taskQueueQueryOptions } from "../lib/queries";

export const Route = createFileRoute("/tasks")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(taskQueueQueryOptions()),
  head: () => ({
    meta: [{ title: "WIP Tasks" }],
  }),
  component: Tasks,
});

type GroupBy = "project" | "taskType";

type JobStatus = TaskQueueJob["status"];

const STATUS_ORDER: JobStatus[] = ["running", "queued", "failed", "cancelled", "passed"];

function taskTypeIcon(taskType: TaskType) {
  switch (taskType) {
    case "test":
      return <FlaskConical className="h-3.5 w-3.5 text-text-400" />;
    case "claude":
      return <Bot className="h-3.5 w-3.5 text-text-400" />;
    case "rebase":
      return <GitMerge className="h-3.5 w-3.5 text-text-400" />;
  }
}

function taskTypeLabel(taskType: TaskType): string {
  switch (taskType) {
    case "test":
      return "Test";
    case "claude":
      return "Claude";
    case "rebase":
      return "Rebase";
  }
}

function statusIcon(status: JobStatus) {
  switch (status) {
    case "queued":
      return <Clock className="h-4 w-4 text-text-400" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-status-yellow" />;
    case "passed":
      return <CheckCircle className="h-4 w-4 text-status-green" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-status-red" />;
    case "cancelled":
      return <Ban className="h-4 w-4 text-text-500" />;
  }
}

function cardStyle(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "border-border-300/50 bg-bg-100";
    case "running":
      return "border-card-running-border bg-card-running-bg";
    case "passed":
      return "border-card-passed-border bg-card-passed-bg";
    case "failed":
      return "border-card-failed-border bg-card-failed-bg";
    case "cancelled":
      return "border-border-300/30 bg-bg-100/50";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function mergeJobs(serverJobs: TaskQueueJob[], liveJobs: Map<string, TaskEvent>): TaskQueueJob[] {
  const merged = new Map<string, TaskQueueJob>();

  for (const job of serverJobs) {
    merged.set(`${job.project}:${job.sha}`, job);
  }

  for (const [key, liveJob] of liveJobs) {
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, { ...existing, status: liveJob.status, message: liveJob.message });
    } else {
      merged.set(key, {
        id: liveJob.id,
        taskType: liveJob.taskType ?? "test",
        project: liveJob.project,
        sha: liveJob.sha,
        shortSha: liveJob.shortSha,
        subject: liveJob.subject,
        branch: liveJob.branch,
        status: liveJob.status,
        message: liveJob.message,
        queuedAt: Date.now(),
      });
    }
  }

  return Array.from(merged.values());
}

function TaskCard({ job }: { job: TaskQueueJob }) {
  const [pushing, setPushing] = useState(false);

  const handlePush = async () => {
    if (!job.branch) return;
    setPushing(true);
    const result = await pushChild({
      data: { project: job.project, sha: job.sha, branch: job.branch },
    });
    setPushing(false);
    if (result.compareUrl) {
      window.open(result.compareUrl, "_blank");
    }
  };

  const duration =
    job.startedAt && job.finishedAt ? formatDuration(job.finishedAt - job.startedAt) : undefined;

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${cardStyle(job.status)}`}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5">{statusIcon(job.status)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link
              to="/item/$project/$sha"
              params={{ project: job.project, sha: job.sha }}
              className="truncate text-sm font-medium text-text-100 hover:underline"
            >
              {job.subject || job.shortSha}
            </Link>
            {duration && <span className="shrink-0 text-xs text-text-500">{duration}</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-text-500">
            <span className="flex items-center gap-0.5" title={taskTypeLabel(job.taskType)}>
              {taskTypeIcon(job.taskType)}
              {taskTypeLabel(job.taskType)}
            </span>
            <Link
              to="/item/$project/$sha"
              params={{ project: job.project, sha: job.sha }}
              className="font-mono hover:underline"
            >
              {job.shortSha}
            </Link>
            {job.branch && (
              <span className="flex items-center gap-0.5">
                <GitBranch className="h-3 w-3" />
                {job.branch}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job.status === "failed" && (
            <Link
              to="/log/$project/$sha"
              params={{ project: job.project, sha: job.sha }}
              className="inline-flex items-center gap-1 rounded-md border border-btn-danger-border bg-btn-danger-bg px-2 py-1 text-xs font-medium text-btn-danger-text transition-colors hover:opacity-80"
            >
              <FileText className="h-3 w-3" />
              Log
            </Link>
          )}
          {job.status === "passed" && job.branch && (
            <button
              type="button"
              onClick={handlePush}
              disabled={pushing}
              className="inline-flex items-center gap-1 rounded-md border border-btn-success-border bg-btn-success-bg px-2 py-1 text-xs font-medium text-btn-success-text transition-colors hover:opacity-80 disabled:opacity-50"
            >
              {pushing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ArrowUpRight className="h-3 w-3" />
              )}
              Push
            </button>
          )}
          {job.status === "passed" && (
            <Link
              to="/log/$project/$sha"
              params={{ project: job.project, sha: job.sha }}
              className="inline-flex items-center gap-1 rounded-md border border-border-300/50 px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-200"
            >
              <FileText className="h-3 w-3" />
              Log
            </Link>
          )}
          {(job.status === "queued" || job.status === "running") && (
            <button
              type="button"
              onClick={async () => {
                await cancelTestFn({ data: { id: job.id } });
              }}
              className="rounded-md border border-border-300/30 p-1 text-text-500 transition-colors hover:bg-bg-200 hover:text-text-300"
              title="Cancel test"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function groupTasks(
  allJobs: TaskQueueJob[],
  groupBy: GroupBy,
): Array<{ key: string; label: string; icon?: React.ReactNode; tasks: TaskQueueJob[] }> {
  const groups = new Map<string, TaskQueueJob[]>();

  for (const job of allJobs) {
    const key = groupBy === "project" ? job.project : job.taskType;
    const existing = groups.get(key) ?? [];
    existing.push(job);
    groups.set(key, existing);
  }

  const entries = Array.from(groups.entries())
    .map(([key, tasks]) => ({
      key,
      label: groupBy === "taskType" ? taskTypeLabel(key as TaskType) : key,
      icon: groupBy === "taskType" ? taskTypeIcon(key as TaskType) : undefined,
      tasks,
    }))
    .sort((a, b) => {
      const aActive = a.tasks.some((j) => j.status === "running" || j.status === "queued");
      const bActive = b.tasks.some((j) => j.status === "running" || j.status === "queued");
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return 0;
    });

  for (const group of entries) {
    group.tasks.sort((a, b) => {
      const aIdx = STATUS_ORDER.indexOf(a.status);
      const bIdx = STATUS_ORDER.indexOf(b.status);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return b.queuedAt - a.queuedAt;
    });
  }

  return entries;
}

function Tasks() {
  const { data: serverJobs } = useSuspenseQuery(taskQueueQueryOptions());
  const { tasks: liveJobs } = useTaskEvents();
  const [testingAll, setTestingAll] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const hasActiveTests = useHasActiveTests();

  const allJobs = mergeJobs(serverJobs, liveJobs);
  const groups = groupTasks(allJobs, groupBy);

  const counts = {
    queued: allJobs.filter((j) => j.status === "queued").length,
    running: allJobs.filter((j) => j.status === "running").length,
    passed: allJobs.filter((j) => j.status === "passed").length,
    failed: allJobs.filter((j) => j.status === "failed").length,
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    await testAllChildren();
    setTestingAll(false);
  };

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Tasks</h1>
          <div className="mt-1 flex items-center gap-4 text-sm text-text-500">
            {counts.running > 0 && (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-status-yellow" />
                {counts.running} running
              </span>
            )}
            {counts.queued > 0 && (
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {counts.queued} queued
              </span>
            )}
            {counts.passed > 0 && (
              <span className="flex items-center gap-1">
                <CheckCircle className="h-3.5 w-3.5 text-status-green" />
                {counts.passed} passed
              </span>
            )}
            {counts.failed > 0 && (
              <span className="flex items-center gap-1">
                <XCircle className="h-3.5 w-3.5 text-status-red" />
                {counts.failed} failed
              </span>
            )}
            {allJobs.length === 0 && <span>No tasks</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border-300/50 text-xs">
            <button
              type="button"
              onClick={() => setGroupBy("project")}
              className={`px-2.5 py-1 rounded-l-lg transition-colors ${
                groupBy === "project"
                  ? "bg-bg-200 text-text-100 font-medium"
                  : "text-text-400 hover:text-text-200"
              }`}
            >
              By Project
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("taskType")}
              className={`px-2.5 py-1 rounded-r-lg transition-colors ${
                groupBy === "taskType"
                  ? "bg-bg-200 text-text-100 font-medium"
                  : "text-text-400 hover:text-text-200"
              }`}
            >
              By Type
            </button>
          </div>
          <button
            type="button"
            onClick={handleTestAll}
            disabled={testingAll || hasActiveTests}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              testingAll || hasActiveTests
                ? "bg-yellow-600/80 text-white"
                : "bg-yellow-600 hover:bg-yellow-700 text-white"
            }`}
          >
            {testingAll || hasActiveTests ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {hasActiveTests ? "Tasks Running..." : "Run All Tests"}
          </button>
        </div>
      </div>

      {allJobs.length === 0 ? (
        <div className="rounded-lg border border-border-300/50 bg-bg-100 p-8 text-center text-text-500">
          <Play className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No tasks have been queued yet.</p>
          <p className="mt-1 text-sm">Use "Run Test" on a commit card to start.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(({ key, label, icon, tasks: groupTasks }) => {
            const groupActive = groupTasks.some(
              (j) => j.status === "running" || j.status === "queued",
            );
            return (
              <section key={key}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  {icon}
                  <span className="text-text-100">{label}</span>
                  {groupActive && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-status-yellow" />
                  )}
                  <span className="font-normal text-text-500">{groupTasks.length}</span>
                </h2>
                <div className="flex flex-col gap-2">
                  {groupTasks.map((job) => (
                    <TaskCard key={job.id} job={job} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
