import { useEffect, useRef } from "react";
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
  FileText,
  Diff,
  Eye,
} from "lucide-react";
import { BranchActions, PullRequestActions } from "../components/commit-actions";
import { CategoryBadge } from "../components/category-badge";
import { GitHubIcon } from "../components/github-icon";
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
import { CATEGORIES, categoryTextClass } from "../lib/category-actions";
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

  const prevTestStatus = useRef(testJob?.status);
  useEffect(() => {
    const prev = prevTestStatus.current;
    const curr = testJob?.status;
    prevTestStatus.current = curr;
    if ((curr === "running" || curr === "queued") && prev !== "running" && prev !== "queued") {
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

  const originRemoteName = "originRemote" in child ? child.originRemote : undefined;
  const isRemote = "pushedToRemote" in child && child.pushedToRemote;
  const ghBranchUrl =
    isBranch && originRemoteName
      ? `https://github.com/${originRemoteName}/tree/${child.branch}`
      : undefined;

  const statLines = stat ? stat.split("\n").filter(Boolean) : [];
  const summaryLine = statLines.length > 0 ? statLines[statLines.length - 1] : undefined;
  const addMatch = summaryLine?.match(/(\d+) insertion/);
  const delMatch = summaryLine?.match(/(\d+) deletion/);
  const additions = addMatch ? Number(addMatch[1]) : 0;
  const deletions = delMatch ? Number(delMatch[1]) : 0;

  return (
    <div className="p-6">
      <Link
        to="/queue"
        className="mb-4 inline-flex items-center gap-1 text-sm text-text-400 hover:text-text-100 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      <div className="grid grid-cols-[280px_1fr] gap-6">
        {/* Sidebar */}
        <aside className="sticky top-6 self-start space-y-4">
          {/* State */}
          <SidebarSection title="State">
            {category && (
              <div className="mb-2">
                <CategoryBadge category={category} />
              </div>
            )}
            <dl className="space-y-1.5 text-xs">
              <SidebarField label="Type">
                {isPr ? "pull_request" : isBranch ? "branch" : "commit"}
              </SidebarField>
              {isSnoozed && (
                <SidebarField label="Snoozed">
                  <span className="text-amber-400">
                    {snoozedEntry?.until ? `Until ${snoozedEntry.until}` : "On Hold"}
                  </span>
                </SidebarField>
              )}
              {child.date && <SidebarField label="Created">{child.date}</SidebarField>}
            </dl>
          </SidebarSection>

          {/* Git */}
          <SidebarSection title="Git">
            <dl className="space-y-1.5 text-xs">
              {isBranch && child.branch && (
                <SidebarField label="Branch">
                  {ghBranchUrl ? (
                    <a
                      href={ghBranchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-blue-400 hover:underline break-all"
                    >
                      {child.branch}
                    </a>
                  ) : (
                    <span className="font-mono break-all">{child.branch}</span>
                  )}
                </SidebarField>
              )}
              <SidebarField label="Commit">
                <span className="font-mono">{child.shortSha}</span>
              </SidebarField>
              {isBranch && (
                <SidebarField label="Remote">
                  {isRemote ? (
                    <span className="inline-flex items-center gap-1 text-blue-400">
                      <Cloud className="h-3 w-3" />
                      Pushed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-text-400">
                      <HardDrive className="h-3 w-3" />
                      Local only
                    </span>
                  )}
                </SidebarField>
              )}
              {isRemote && "localAhead" in child && child.localAhead && (
                <SidebarField label="Sync">
                  <span className="inline-flex items-center gap-1 text-amber-400">
                    <AlertCircle className="h-3 w-3" />
                    Local ahead
                  </span>
                </SidebarField>
              )}
              {isRemote && !("localAhead" in child && child.localAhead) && (
                <SidebarField label="Sync">
                  <span className="inline-flex items-center gap-1 text-green-400">
                    <Check className="h-3 w-3" />
                    In sync
                  </span>
                </SidebarField>
              )}
            </dl>
          </SidebarSection>

          {/* PR */}
          {isPr && (
            <SidebarSection title="Pull Request">
              <dl className="space-y-1.5 text-xs">
                <SidebarField label="Number">
                  <a
                    href={child.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-blue-400 hover:underline"
                  >
                    <GitHubIcon className="h-3 w-3" />#{child.prNumber}
                  </a>
                </SidebarField>
                <SidebarField label="Review">
                  {"reviewStatus" in child ? String(child.reviewStatus) : "unknown"}
                </SidebarField>
                <SidebarField label="Checks">
                  {"checkStatus" in child ? String(child.checkStatus) : "unknown"}
                </SidebarField>
              </dl>
            </SidebarSection>
          )}

          {/* Repository */}
          <SidebarSection title="Repository">
            <dl className="space-y-1.5 text-xs">
              <SidebarField label="Name">
                <a
                  href={`https://github.com/${child.remote}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline break-all"
                >
                  {child.remote}
                </a>
              </SidebarField>
              {projectInfo && (
                <>
                  <SidebarField label="Dirty">
                    <span className={projectInfo.dirty ? "text-red-400" : "text-green-400"}>
                      {String(projectInfo.dirty)}
                    </span>
                  </SidebarField>
                  <SidebarField label="Test configured">
                    <span
                      className={projectInfo.hasTestConfigured ? "text-green-400" : "text-red-400"}
                    >
                      {String(projectInfo.hasTestConfigured)}
                    </span>
                  </SidebarField>
                </>
              )}
            </dl>
          </SidebarSection>
        </aside>

        {/* Main content */}
        <main className="min-w-0">
          {/* Hero banner */}
          <div className="mb-6 rounded-lg border border-border-300/30 bg-bg-000 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold text-text-100 leading-snug">
                  {child.subject}
                </h1>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-text-400">
                  {category && (
                    <Link to="/states" search={{ state: category }} className="hover:underline">
                      <span className={categoryTextClass(category)}>
                        {CATEGORIES[category].label}
                      </span>
                    </Link>
                  )}
                  {child.date && <span>Last updated {child.date}</span>}
                </div>
              </div>
            </div>

            {/* Test running/queued indicator */}
            {testJob && (testJob.status === "running" || testJob.status === "queued") && (
              <div
                className={`mt-4 flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium ${
                  testJob.status === "running"
                    ? "border border-card-running-border bg-card-running-bg text-status-yellow"
                    : "border border-border-300/50 bg-bg-100 text-text-300"
                }`}
              >
                {testJob.status === "running" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Clock className="h-4 w-4" />
                )}
                {testJob.status === "running" ? "Test Running..." : "Test Queued"}
              </div>
            )}

            {/* Action buttons */}
            {category && (
              <div className="mt-4 border-t border-border-300/20 pt-4">
                {isPr ? (
                  <PullRequestActions item={child as any} category={category} layout="row" />
                ) : (
                  <BranchActions item={child as any} category={category} layout="row" />
                )}
              </div>
            )}
          </div>

          {/* Nav strip */}
          <nav className="mb-6 flex items-center gap-1 border-b border-border-300/30">
            <NavTab href={`#overview`} active>
              <Eye className="h-3.5 w-3.5" />
              Overview
            </NavTab>
            <NavTab href={`/diff/${project}/${sha}`}>
              <Diff className="h-3.5 w-3.5" />
              Diff
            </NavTab>
            <NavTab href={`/log/${project}/${sha}`}>
              <FileText className="h-3.5 w-3.5" />
              Test Log
            </NavTab>
            {isPr && (
              <NavTab href={child.prUrl!} external>
                <GitHubIcon className="h-3.5 w-3.5" />
                GitHub
              </NavTab>
            )}
          </nav>

          {/* Overview tab content */}

          {/* Failed Checks summary */}
          {child.failedChecks && child.failedChecks.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-text-200">Failed Checks</h2>
              <div className="rounded-lg border border-red-500/20 bg-red-950/10 p-3">
                <ul className="space-y-1">
                  {child.failedChecks.map(
                    (check: { name: string; url?: string; conclusion?: string }) => (
                      <li key={check.name} className="flex items-center gap-2 text-xs">
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                        <span className="text-red-300">{check.conclusion || "failed"}</span>
                        {check.url ? (
                          <a
                            href={check.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline"
                          >
                            {check.name}
                          </a>
                        ) : (
                          <span className="text-text-200">{check.name}</span>
                        )}
                      </li>
                    ),
                  )}
                </ul>
                {log && (
                  <Link
                    to="/log/$project/$sha"
                    params={{ project, sha }}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-text-400 hover:text-text-100 transition-colors"
                  >
                    View Test Log
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>
            </div>
          )}

          {/* Diff Summary */}
          <div className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-text-200">Diff Summary</h2>
            <div className="rounded-lg border border-border-300/30 bg-bg-100 p-3">
              <div className="mb-2 flex items-center gap-3 text-xs">
                <span className="text-text-300">
                  {files.length} file{files.length !== 1 ? "s" : ""} changed
                </span>
                {additions > 0 && <span className="text-green-400">+{additions}</span>}
                {deletions > 0 && <span className="text-red-400">-{deletions}</span>}
              </div>
              {files.length > 0 && (
                <ul className="space-y-0.5">
                  {files.map((file) => (
                    <li key={file.newFileName} className="flex items-center gap-2 text-xs">
                      <FileText className="h-3 w-3 shrink-0 text-text-500" />
                      <span className="font-mono text-text-300 truncate">{file.newFileName}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                to="/diff/$project/$sha"
                params={{ project, sha }}
                className="mt-2 inline-flex items-center gap-1 text-xs text-text-400 hover:text-text-100 transition-colors"
              >
                View Full Diff
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>

          {/* Local Changes (working tree diff for local_changes category) */}
          {isLocalChanges && workingTreeDiff && workingTreeDiff.files.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-text-200">Local Changes</h2>
              <div className="rounded-lg border border-border-300/30 bg-bg-100 p-3">
                <div className="mb-2 text-xs text-text-300">
                  {workingTreeDiff.files.length} file{workingTreeDiff.files.length !== 1 ? "s" : ""}{" "}
                  with uncommitted changes
                </div>
                <ul className="space-y-0.5">
                  {workingTreeDiff.files.map((file) => (
                    <li key={file.newFileName} className="flex items-center gap-2 text-xs">
                      <FileText className="h-3 w-3 shrink-0 text-text-500" />
                      <span className="font-mono text-text-300 truncate">{file.newFileName}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Test Log preview */}
          {log && (
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between">
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
                className="max-h-48 overflow-auto rounded-lg bg-bg-200 p-4 font-mono text-xs leading-relaxed text-text-100"
              />
            </div>
          )}

          {/* Live Test Output */}
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
        </main>
      </div>
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-300/30 bg-bg-100 p-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-500">
        {title}
      </h3>
      {children}
    </div>
  );
}

function SidebarField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-text-500">{label}</dt>
      <dd className="text-right text-text-200 min-w-0">{children}</dd>
    </div>
  );
}

function NavTab({
  href,
  children,
  active,
  external,
}: {
  href: string;
  children: React.ReactNode;
  active?: boolean;
  external?: boolean;
}) {
  const className = `inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
    active
      ? "border-blue-500 text-text-100"
      : "border-transparent text-text-400 hover:text-text-200 hover:border-border-300/50"
  }`;

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }

  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
