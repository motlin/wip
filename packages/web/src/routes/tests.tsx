import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { testAllChildren, cancelTestFn, pushChild } from "../lib/server-fns";
import type { TestQueueJob } from "../lib/server-fns";
import { useTestEvents, type JobEvent } from "../lib/use-test-events";
import { useHasActiveTests } from "../lib/test-events-context";
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
} from "lucide-react";
import { testQueueQueryOptions } from "../lib/queries";

export const Route = createFileRoute("/tests")({
  loader: ({ context: { queryClient } }) => queryClient.ensureQueryData(testQueueQueryOptions()),
  head: () => ({
    meta: [{ title: "WIP Tests" }],
  }),
  component: Tests,
});

type JobStatus = TestQueueJob["status"];

const STATUS_ORDER: JobStatus[] = ["running", "queued", "failed", "cancelled", "passed"];

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

function mergeJobs(serverJobs: TestQueueJob[], liveJobs: Map<string, JobEvent>): TestQueueJob[] {
  const merged = new Map<string, TestQueueJob>();

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

function TestCard({ job }: { job: TestQueueJob }) {
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

function Tests() {
  const { data: serverJobs } = useSuspenseQuery(testQueueQueryOptions());
  const { jobs: liveJobs } = useTestEvents();
  const [testingAll, setTestingAll] = useState(false);
  const hasActiveTests = useHasActiveTests();

  const allJobs = mergeJobs(serverJobs, liveJobs);

  const byProject = new Map<string, TestQueueJob[]>();
  for (const job of allJobs) {
    const existing = byProject.get(job.project) ?? [];
    existing.push(job);
    byProject.set(job.project, existing);
  }

  const projectEntries = Array.from(byProject.entries()).sort(([, a], [, b]) => {
    const aActive = a.some((j) => j.status === "running" || j.status === "queued");
    const bActive = b.some((j) => j.status === "running" || j.status === "queued");
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return 0;
  });

  for (const [, jobs] of projectEntries) {
    jobs.sort((a, b) => {
      const aIdx = STATUS_ORDER.indexOf(a.status);
      const bIdx = STATUS_ORDER.indexOf(b.status);
      if (aIdx !== bIdx) return aIdx - bIdx;
      return b.queuedAt - a.queuedAt;
    });
  }

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
          <h1 className="text-xl font-semibold">Tests</h1>
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
            {allJobs.length === 0 && <span>No test jobs</span>}
          </div>
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
          {hasActiveTests ? "Tests Running..." : "Run All Tests"}
        </button>
      </div>

      {allJobs.length === 0 ? (
        <div className="rounded-lg border border-border-300/50 bg-bg-100 p-8 text-center text-text-500">
          <Play className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No tests have been queued yet.</p>
          <p className="mt-1 text-sm">Use "Run Test" on a commit card to start testing.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {projectEntries.map(([project, jobs]) => {
            const projectActive = jobs.some((j) => j.status === "running" || j.status === "queued");
            return (
              <section key={project}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <span className="text-text-100">{project}</span>
                  {projectActive && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-status-yellow" />
                  )}
                  <span className="font-normal text-text-500">{jobs.length}</span>
                </h2>
                <div className="flex flex-col gap-2">
                  {jobs.map((job) => (
                    <TestCard key={job.id} job={job} />
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
