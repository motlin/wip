import { Fragment, useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  Clock,
  Cloud,
  HardDrive,
  ArrowDown,
  ExternalLink,
  AlertCircle,
  Check,
  SearchX,
  XCircle,
} from "lucide-react";
import "@git-diff-view/react/styles/diff-view.css";
import { CommitCard } from "../components/commit-card";
import { BranchCard } from "../components/branch-card";
import { PullRequestCard } from "../components/pull-request-card";
import { DiffPanel } from "../components/diff-section";
import { AnsiText } from "../components/ansi-text";
import {
  projectChildrenQueryOptions,
  diffQueryOptions,
  workingTreeDiffQueryOptions,
  testLogQueryOptions,
  projectsQueryOptions,
  snoozedQueryOptions,
} from "../lib/queries";
import { classifyCommit, classifyBranch, classifyPullRequest } from "../lib/classify";
import { applyTransition } from "@wip/shared";
import { CATEGORIES, CATEGORY_PRIORITY } from "../lib/category-actions";
import { useTestJob, useTestLog } from "../lib/task-events-context";
import { useAutoTail } from "../lib/use-auto-tail";

export const Route = createFileRoute("/item/$project/$sha")({
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.ensureQueryData(projectChildrenQueryOptions(params.project)),
      queryClient.ensureQueryData(diffQueryOptions(params.project, params.sha)),
      queryClient.ensureQueryData(testLogQueryOptions(params.project, params.sha)),
      queryClient.ensureQueryData(projectsQueryOptions()),
      queryClient.ensureQueryData(snoozedQueryOptions()),
    ]),
  head: ({ params }) => ({
    meta: [{ title: `${params.project} / ${params.sha.slice(0, 7)}` }],
  }),
  component: ItemDetail,
  errorComponent: ItemDetailError,
});

function ItemDetailError({ error }: { error: unknown }) {
  return (
    <div className="p-6">
      <Link
        to="/queue"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
      <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-red-500/30 bg-bg-100 p-8">
        <XCircle className="h-8 w-8 text-red-400" />
        <h2 className="text-sm font-semibold text-red-400">Failed to load item</h2>
        <pre className="max-w-full overflow-auto rounded bg-bg-200 p-3 font-mono text-xs text-text-300">
          {error instanceof Error ? error.message : String(error)}
        </pre>
        <Link
          to="/queue"
          className="mt-2 inline-flex items-center gap-1 rounded bg-bg-200 px-3 py-1.5 text-xs font-medium text-text-200 transition-colors hover:bg-bg-300"
        >
          Back to Queue
        </Link>
      </div>
    </div>
  );
}

function ItemDetail() {
  const { project, sha } = Route.useParams();
  const { data: children } = useSuspenseQuery(projectChildrenQueryOptions(project));
  const child = children.find((c) => c.sha === sha) ?? null;
  const {
    data: { files, stat },
  } = useSuspenseQuery(diffQueryOptions(project, sha));
  const {
    data: { log },
  } = useSuspenseQuery(testLogQueryOptions(project, sha));
  const { data: projects } = useSuspenseQuery(projectsQueryOptions());
  const { data: snoozedItems } = useSuspenseQuery(snoozedQueryOptions());
  const projectInfo = projects.find((p) => p.name === project);
  const isSnoozed = snoozedItems.some((s) => s.project === project && s.sha === sha);
  const snoozedEntry = snoozedItems.find((s) => s.project === project && s.sha === sha);
  const testJob = useTestJob(sha, project);
  const liveLog = useTestLog(sha, project);
  const {
    containerRef: liveLogRef,
    isFollowing,
    setFollowing,
    scrollToStart,
    handleScroll,
  } = useAutoTail(liveLog);

  // Scroll to the live log panel when a test transitions to running/queued.
  const prevTestStatus = useRef(testJob?.status);
  useEffect(() => {
    const prev = prevTestStatus.current;
    const curr = testJob?.status;
    prevTestStatus.current = curr;
    if ((curr === "running" || curr === "queued") && prev !== "running" && prev !== "queued") {
      // Small delay to let the live log DOM node render before scrolling.
      requestAnimationFrame(() => scrollToStart());
      setFollowing(true);
    }
  }, [testJob?.status, scrollToStart, setFollowing]);

  if (!child) {
    if (isSnoozed && snoozedEntry) {
      return (
        <div className="p-6">
          <Link
            to="/queue"
            className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
          <div className="mt-4 rounded-lg border border-border-300/30 bg-bg-100 p-4">
            <h2 className="mb-2 text-sm font-semibold text-text-500">{CATEGORIES.snoozed.label}</h2>
            <p className="font-mono text-xs text-text-300">
              {snoozedEntry.shortSha || sha.slice(0, 7)}
            </p>
            <p className="mt-1 text-sm text-text-100">{snoozedEntry.subject}</p>
            <p className="mt-2 text-xs text-amber-400">
              {snoozedEntry.until ? `Snoozed until ${snoozedEntry.until}` : "On Hold"}
            </p>
            <p className="mt-2 text-xs text-text-500">
              Commit no longer found in git — the branch may have been rebased.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="p-6">
        <Link
          to="/queue"
          className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>
        <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-border-300/30 bg-bg-100 p-8">
          <SearchX className="h-8 w-8 text-text-500" />
          <h2 className="text-sm font-semibold text-text-200">Item not found</h2>
          <p className="text-xs text-text-400">
            {project} / {sha.slice(0, 7)} could not be located. The branch may have been rebased or
            deleted.
          </p>
          <Link
            to="/queue"
            className="mt-2 inline-flex items-center gap-1 rounded bg-bg-200 px-3 py-1.5 text-xs font-medium text-text-200 transition-colors hover:bg-bg-300"
          >
            Back to Queue
          </Link>
        </div>
      </div>
    );
  }

  const isPr = "prUrl" in child && child.prUrl;
  const isBranch = "branch" in child;
  const baseCategory = isSnoozed
    ? ("snoozed" as const)
    : projectInfo
      ? isPr
        ? classifyPullRequest(child as any)
        : isBranch
          ? classifyBranch(child as any, projectInfo)
          : classifyCommit(child as any, projectInfo)
      : undefined;
  const category =
    baseCategory && testJob?.transition
      ? (applyTransition(baseCategory, testJob.transition) ?? baseCategory)
      : baseCategory;

  const isLocalChanges = category === "local_changes";
  const { data: workingTreeDiff } = useQuery({
    ...workingTreeDiffQueryOptions(project),
    enabled: isLocalChanges,
  });

  return (
    <div className="p-6">
      <Link
        to="/queue"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <div className="mb-6">
        {category && (
          <h2 className={`mb-2 text-sm font-semibold ${CATEGORIES[category].color}`}>
            <Link to="/states" search={{ state: category }} className="hover:underline">
              {CATEGORIES[category].label}
              <code className="ml-2 text-xs font-normal text-text-300">
                #{CATEGORY_PRIORITY.indexOf(category) + 1} {category}
              </code>
            </Link>
          </h2>
        )}
        {isPr ? (
          <PullRequestCard pr={child as any} category={category!} />
        ) : isBranch ? (
          <BranchCard branch={child as any} category={category!} />
        ) : (
          <CommitCard commit={child as any} />
        )}
      </div>

      {testJob && (testJob.status === "running" || testJob.status === "queued") && (
        <div
          className={`mb-6 rounded-lg border ${
            testJob.status === "running"
              ? "border-card-running-border bg-card-running-bg"
              : "border-border-300/50 bg-bg-100"
          }`}
        >
          <div className="flex items-center gap-3 px-4 py-3">
            {testJob.status === "running" ? (
              <Loader2 className="h-5 w-5 animate-spin text-status-yellow" />
            ) : (
              <Clock className="h-5 w-5 text-text-400" />
            )}
            <p className="text-sm font-medium text-text-100">
              {testJob.status === "running" ? "Test Running..." : "Test Queued"}
            </p>
          </div>
        </div>
      )}

      <div className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-text-200">State</h2>
        <div className="rounded-lg border border-border-300/30 bg-bg-100 p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            {category && (
              <div className="inline-flex items-center rounded bg-bg-200 px-2 py-1 text-xs font-semibold text-text-100">
                {CATEGORIES[category].label}
              </div>
            )}
            <div
              className={`inline-flex items-center rounded px-2 py-1 text-xs font-semibold ${isSnoozed ? "bg-amber-500/20 text-amber-400" : "bg-bg-200 text-text-400"}`}
            >
              {isSnoozed
                ? `Snoozed${snoozedEntry?.until ? ` until ${snoozedEntry.until}` : ""}`
                : "Not Snoozed"}
            </div>
            {isBranch &&
              ("pushedToRemote" in child && child.pushedToRemote ? (
                <>
                  <div className="inline-flex items-center gap-1 rounded bg-blue-500/20 px-2 py-1 text-xs font-semibold text-blue-400">
                    <Cloud className="h-3 w-3" />
                    Remote Branch
                  </div>
                  {"localAhead" in child && child.localAhead ? (
                    <div className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-1 text-xs font-semibold text-amber-400">
                      <AlertCircle className="h-3 w-3" />
                      Local ahead of remote
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-1 text-xs font-semibold text-green-400">
                      <Check className="h-3 w-3" />
                      In sync
                    </div>
                  )}
                </>
              ) : (
                <div className="inline-flex items-center gap-1 rounded bg-bg-200 px-2 py-1 text-xs font-semibold text-text-400">
                  <HardDrive className="h-3 w-3" />
                  Local Only
                </div>
              ))}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-text-400">type</dt>
            <dd className="font-mono text-text-200">
              {isPr ? "pull_request" : isBranch ? "branch" : "commit"}
            </dd>
            {Object.entries(child).map(([key, value]) => {
              if (key === "subject" || key === "failureTail") return null;
              const originRemoteName =
                "originRemote" in child ? (child as any).originRemote : undefined;
              const isRemote = "pushedToRemote" in child && (child as any).pushedToRemote;
              return (
                <Fragment key={key}>
                  <dt className="text-text-400">{key}</dt>
                  <dd className="font-mono text-text-200 break-all">
                    {key === "branch" &&
                    typeof value === "string" &&
                    isRemote &&
                    originRemoteName ? (
                      <a
                        href={`https://github.com/${originRemoteName}/tree/${value}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {value}
                      </a>
                    ) : key === "prUrl" && typeof value === "string" ? (
                      <a
                        href={value}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {value}
                      </a>
                    ) : key === "failedChecks" && Array.isArray(value) ? (
                      <ul className="list-none space-y-0.5">
                        {(value as Array<{ name: string; url?: string; conclusion?: string }>).map(
                          (check) => (
                            <li key={check.name} className="flex items-center gap-1.5">
                              <span className="text-red-600 dark:text-red-400">
                                {check.conclusion || "failed"}
                              </span>
                              {check.url ? (
                                <a
                                  href={check.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline dark:text-blue-400"
                                >
                                  {check.name}
                                </a>
                              ) : (
                                <span>{check.name}</span>
                              )}
                            </li>
                          ),
                        )}
                      </ul>
                    ) : key === "alreadyOnRemote" &&
                      typeof value === "object" &&
                      value &&
                      "branch" in value &&
                      originRemoteName ? (
                      <a
                        href={`https://github.com/${originRemoteName}/tree/${(value as any).branch}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        {(value as any).branch}
                      </a>
                    ) : value === undefined ? (
                      <span className="text-text-500">undefined</span>
                    ) : value === null ? (
                      <span className="text-text-500">null</span>
                    ) : typeof value === "boolean" ? (
                      <span
                        className={
                          value
                            ? "text-green-600 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {String(value)}
                      </span>
                    ) : typeof value === "object" ? (
                      JSON.stringify(value)
                    ) : (
                      String(value)
                    )}
                  </dd>
                </Fragment>
              );
            })}
            {projectInfo && (
              <>
                <dt className="text-text-400 border-t border-border-300/30 pt-1 mt-1">
                  project.dirty
                </dt>
                <dd className="font-mono text-text-200 border-t border-border-300/30 pt-1 mt-1">
                  <span
                    className={
                      projectInfo.dirty
                        ? "text-red-600 dark:text-red-400"
                        : "text-green-600 dark:text-green-400"
                    }
                  >
                    {String(projectInfo.dirty)}
                  </span>
                </dd>
                <dt className="text-text-400">project.hasTestConfigured</dt>
                <dd className="font-mono text-text-200">
                  <span
                    className={
                      projectInfo.hasTestConfigured
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400"
                    }
                  >
                    {String(projectInfo.hasTestConfigured)}
                  </span>
                </dd>
                <dt className="text-text-400">project.detachedHead</dt>
                <dd className="font-mono text-text-200">{String(projectInfo.detachedHead)}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {isLocalChanges && workingTreeDiff && workingTreeDiff.files.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-text-200">Local Changes</h2>
          <DiffPanel files={workingTreeDiff.files} stat={workingTreeDiff.stat} />
        </div>
      )}

      <div className="mb-6">
        <DiffPanel files={files} stat={stat} />
      </div>

      {log && (
        <div className="mb-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-200">Test Log</h2>
            <Link
              to="/log/$project/$sha"
              params={{ project, sha }}
              className="inline-flex items-center gap-1 text-xs text-text-400 hover:text-text-100 transition-colors"
            >
              Full Log
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <AnsiText
            text={log}
            className="overflow-auto rounded-lg bg-bg-200 p-4 font-mono text-xs leading-relaxed text-text-100"
          />
        </div>
      )}

      {liveLog && (
        <div className="relative">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-200">Live Test Output</h2>
            <Link
              to="/log/$project/$sha"
              params={{ project, sha }}
              className="inline-flex items-center gap-1 text-xs text-text-400 hover:text-text-100 transition-colors"
            >
              Full Log
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
          <div
            ref={liveLogRef}
            onScroll={handleScroll}
            className="max-h-96 overflow-y-auto rounded-lg border border-border-300/30 bg-bg-200 scrollbar-thin"
          >
            <AnsiText
              text={liveLog}
              className="p-4 font-mono text-xs leading-relaxed text-text-100"
            />
          </div>
          {!isFollowing && (
            <button
              type="button"
              onClick={() => setFollowing(true)}
              className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 mt-2 inline-flex items-center gap-1.5 rounded-full bg-bg-000 border border-border-300/50 px-3 py-1.5 text-xs font-medium text-text-200 shadow-lg transition-colors hover:bg-bg-100"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              Follow
            </button>
          )}
        </div>
      )}
    </div>
  );
}
