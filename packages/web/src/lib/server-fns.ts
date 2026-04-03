import { createServerFn } from "@tanstack/react-start";
import {
  clearExpiredSnoozes,
  discoverAllProjects,
  fetchAssignedIssues,
  fetchAllProjectItems,
  findIncompleteTodoTasks,
  getAllSnoozedForDisplay,
  getBranchNames,
  getChildren,
  getChildCommits,
  getMiseEnv,
  getPrStatuses,
  getProjectsDirs,
  getRemoteBranchInfo,
  getSnoozedSet,
  getTestLogDir,
  getTestResultsForProject,
  invalidatePrCache,
  invalidateIssuesCache,
  invalidateProjectItemsCache,
  isSkippable,
  log,
  parseBranch,
  snoozeItem,
  suggestBranchNames,
  unsnoozeItem,
  getCachedUpstreamSha,
  getCachedMergeStatuses,
  cacheMergeStatus,
  invalidateMergeStatus,
  getNeedsRebaseBranches,
  getCachedProjectList,
  setCachedProjectList,
} from "@wip/shared";
import type {
  ProjectInfo,
  GitChildResult,
  TodoItem as SharedTodoItem,
  IssueResult,
  ProjectItemResult,
} from "@wip/shared";
import {
  type ActionResult,
  type Category,
  type SnoozedChild,
  PushChildInputSchema,
  TestChildInputSchema,
  SnoozeChildInputSchema,
  UnsnoozeChildInputSchema,
  CancelTestInputSchema,
  CreatePrInputSchema,
  RefreshChildInputSchema,
  CreateBranchInputSchema,
  DeleteBranchInputSchema,
  ForcePushInputSchema,
  RenameBranchInputSchema,
  ApplyFixesInputSchema,
  RebaseLocalInputSchema,
  MergePrInputSchema,
  TestQueueJobSchema,
  type TestQueueJob,
} from "@wip/shared";

import { tracedExeca } from "@wip/shared/services/traced-execa.js";
import { getTracer } from "@wip/shared/services/telemetry.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";

async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(`fn.${name}`, async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

export type { ActionResult, Category, SnoozedChild, GitChildResult, TestQueueJob };

export type ProjectChildrenResult = GitChildResult[];

let cachedProjects: ProjectInfo[] | null = null;
let cachedProjectsTime = 0;
const PROJECT_CACHE_TTL = 5 * 60 * 1000;
let discoverInFlight: Promise<ProjectInfo[]> | null = null;

async function refreshProjectCache(): Promise<ProjectInfo[]> {
  if (discoverInFlight) return discoverInFlight;
  const projectsDirs = getProjectsDirs();
  discoverInFlight = discoverAllProjects(projectsDirs).then(async (projects) => {
    cachedProjects = projects;
    cachedProjectsTime = Date.now();
    discoverInFlight = null;
    setCachedProjectList(projects);
    const { projectEmitter } = await import("./project-events.js");
    projectEmitter.emit("projects", projects);
    return projects;
  });
  return discoverInFlight;
}

async function ensureProjects(): Promise<void> {
  if (cachedProjects && Date.now() - cachedProjectsTime <= PROJECT_CACHE_TTL) return;
  const fromDb = getCachedProjectList();
  if (fromDb) {
    cachedProjects = fromDb;
    cachedProjectsTime = Date.now();
    refreshProjectCache().catch(() => {});
    return;
  }
  await refreshProjectCache();
}

async function resolveProject(project: string): Promise<ProjectInfo> {
  await ensureProjects();
  const p = cachedProjects!.find((proj) => proj.name === project);
  if (!p) throw new Error(`Project not found: ${project}`);
  return p;
}

export const getProjects = createServerFn({ method: "GET" }).handler(async () =>
  traced("getProjects", async () => {
    await ensureProjects();
    return cachedProjects!;
  }),
);

export const getProjectChildren = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ project: z.string() }).parse(input))
  .handler(
    async ({ data }): Promise<ProjectChildrenResult> =>
      traced("getProjectChildren", async () => {
        let p: ProjectInfo;
        try {
          p = await resolveProject(data.project);
        } catch (error: unknown) {
          log.general.error({ project: data.project, error }, "Project resolution failed");
          return [];
        }

        const prStatuses = await getPrStatuses(p.dir, p.name);

        const upstreamSha = getCachedUpstreamSha(p.name);
        const mergeStatusMap = new Map<
          string,
          { commitsAhead: number; commitsBehind: number; rebaseable: boolean | null }
        >();
        if (upstreamSha) {
          for (const ms of getCachedMergeStatuses(p.name, upstreamSha)) {
            mergeStatusMap.set(ms.sha, ms);
          }
        }

        const [children, remoteBranchInfo] = await Promise.all([
          getChildCommits(
            p.dir,
            p.upstreamRef,
            p.hasTestConfigured,
            prStatuses,
            p.name,
            mergeStatusMap,
          ),
          getRemoteBranchInfo(p.dir),
        ]);

        // Discover branches that need rebase (not descendants of upstream)
        const descendantShas = new Set(children.map((c) => c.sha));
        const needsRebaseBranches = await getNeedsRebaseBranches(
          p.dir,
          p.upstreamRef,
          descendantShas,
          p.name,
          prStatuses,
          remoteBranchInfo.remoteBranches,
          remoteBranchInfo.remoteBranchRefs,
          mergeStatusMap,
        );

        clearExpiredSnoozes();
        const snoozedSet = getSnoozedSet();
        const seen = new Set<string>();
        const allChildren = [...children, ...needsRebaseBranches].filter((c) => {
          if (snoozedSet.has(`${p.name}:${c.sha}`)) return false;
          if (seen.has(c.sha)) return false;
          seen.add(c.sha);
          return true;
        });

        // Collect all children that need branch name suggestions and fetch cached names up front
        const defaultBranchPattern = /^(main|master)$/;
        const namingKeys = allChildren
          .filter((c) => !c.branch || defaultBranchPattern.test(c.branch))
          .map((c) => ({ sha: c.sha, project: p.name, subject: c.subject, dir: p.dir }));
        const cachedNames =
          namingKeys.length > 0 ? getBranchNames(namingKeys) : new Map<string, string>();

        // Fire off background naming for any uncached items
        const uncachedKeys = namingKeys.filter((k) => !cachedNames.has(`${k.project}:${k.sha}`));
        if (uncachedKeys.length > 0) {
          suggestBranchNames(uncachedKeys).catch(() => {});
        }

        const headSha = (
          await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false })
        ).stdout.trim();

        const results: GitChildResult[] = allChildren.map((child) => {
          // Read failure tail for failed tests
          let failureTail: string | undefined;
          if (child.testStatus === "failed") {
            const logPath = path.join(getTestLogDir(p.name), `${child.sha}.log`);
            if (fs.existsSync(logPath)) {
              const content = fs.readFileSync(logPath, "utf-8").trimEnd();
              const lines = content.split("\n");
              failureTail = lines.slice(-5).join("\n");
            }
          }

          const ms = mergeStatusMap.get(child.sha);
          const suggestedBranch = cachedNames.get(`${p.name}:${child.sha}`);

          return {
            project: p.name,
            remote: p.remote,
            sha: child.sha,
            shortSha: child.shortSha,
            subject: child.subject,
            date: child.date,
            branch: child.branch,
            testStatus: child.testStatus,
            checkStatus: child.checkStatus,
            skippable: child.skippable,
            pushedToRemote: child.pushedToRemote,
            localAhead: child.localAhead,
            needsRebase: child.needsRebase,
            reviewStatus: child.reviewStatus,
            prUrl: child.prUrl,
            prNumber: child.prNumber,
            failedChecks: child.failedChecks,
            commitsBehind: ms?.commitsBehind ?? child.commitsBehind,
            commitsAhead: ms?.commitsAhead ?? child.commitsAhead,
            rebaseable:
              ms?.rebaseable ?? (child.rebaseable === undefined ? undefined : child.rebaseable),
            alreadyOnRemote: child.alreadyOnRemote,
            failureTail,
            suggestedBranch:
              child.branch && !defaultBranchPattern.test(child.branch)
                ? undefined
                : suggestedBranch,
            blockReason:
              child.branch && p.dirty && child.sha === headSha
                ? `Working tree is dirty — commit changes in ${p.name} before testing`
                : undefined,
            blockCommand:
              child.branch && p.dirty && child.sha === headSha
                ? `cd ${p.dir} && claude --permission-mode acceptEdits /git:commit`
                : undefined,
          };
        });

        return results;
      }),
  );

export const getProjectTodos = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ project: z.string() }).parse(input))
  .handler(
    async ({ data }): Promise<SharedTodoItem[]> =>
      traced("getProjectTodos", async () => {
        let p: ProjectInfo;
        try {
          p = await resolveProject(data.project);
        } catch (error: unknown) {
          log.general.error({ project: data.project, error }, "Project resolution failed");
          return [];
        }

        const tasks = findIncompleteTodoTasks(p.dir);
        return tasks.map((task) => ({
          project: p.name,
          title: task.text,
          sourceFile: task.sourceFile,
          sourceLabel: path.relative(p.dir, task.sourceFile),
        }));
      }),
  );

export const getIssues = createServerFn({ method: "GET" }).handler(async () =>
  traced("getIssues", async () => {
    return fetchAssignedIssues();
  }),
);

export const getProjectItemsFn = createServerFn({ method: "GET" }).handler(async () =>
  traced("getProjectItemsFn", async () => {
    return fetchAllProjectItems();
  }),
);

export const getIssueByNumber = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ project: z.string(), number: z.number() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<IssueResult | null> =>
      traced("getIssueByNumber", async () => {
        const issues = await fetchAssignedIssues();
        const p = cachedProjects?.find((proj) => proj.name === data.project);
        for (const issue of issues) {
          if (issue.number !== data.number) continue;
          const repoKey = issue.repository.nameWithOwner.toLowerCase();
          if ((p && p.remote.toLowerCase() === repoKey) || issue.repository.name === data.project) {
            return issue;
          }
        }
        return null;
      }),
  );

export const getProjectItemByNumber = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ project: z.string(), number: z.number() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<ProjectItemResult | null> =>
      traced("getProjectItemByNumber", async () => {
        const items = await fetchAllProjectItems();
        for (const item of items) {
          if (item.number !== data.number) continue;
          const repoName = item.repository ?? "unknown";
          const p = cachedProjects?.find(
            (proj) => proj.remote.toLowerCase() === repoName.toLowerCase(),
          );
          const projectName = p?.name ?? repoName.split("/").pop() ?? repoName;
          if (projectName === data.project) {
            return {
              project: projectName,
              repository: repoName,
              url: item.url,
              number: item.number,
              title: item.title,
              status: item.status ?? "",
              type: item.type,
              labels: item.labels ?? [],
            };
          }
        }
        return null;
      }),
  );

export const pushChild = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PushChildInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("pushChild", async () => {
        const p = await resolveProject(data.project);

        // Validate transition: push can be done from ready_to_push or no_test
        // Only check dirty state if operating on HEAD
        const headSha = (
          await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false })
        ).stdout.trim();
        if (p.dirty && data.sha === headSha) {
          log.subprocess.debug(
            { project: data.project, sha: data.sha },
            "Pushing HEAD from dirty project state",
          );
        }

        // Resolve shortSha and subject from git
        const logResult = await tracedExeca(
          "git",
          ["-C", p.dir, "log", "-1", "--format=%h%x00%s", data.sha],
          { reject: false },
        );
        const logFields = logResult.stdout.split("\0");
        const shortSha = logFields[0] ?? "";
        const subject = logFields[1] ?? "";

        const { getBranchName } = await import("@wip/shared");
        const branchName =
          data.branch ??
          getBranchName(data.sha, p.name) ??
          subject
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");

        if (!data.branch) {
          const branchResult = await tracedExeca(
            "git",
            ["-C", p.dir, "branch", branchName, data.sha],
            {
              reject: false,
            },
          );
          if (branchResult.exitCode !== 0) {
            return { ok: false, message: `Failed to create branch: ${branchResult.stderr}` };
          }
        }

        const pushResult = await tracedExeca(
          "git",
          ["-C", p.dir, "push", "-u", p.upstreamRemote, `${branchName}:refs/heads/${branchName}`],
          { reject: false },
        );

        if (pushResult.exitCode === 0) {
          invalidatePrCache(data.project);
          const compareUrl = `https://github.com/${p.remote}/compare/${branchName}?expand=1`;
          return { ok: true, message: `Pushed ${shortSha} to ${branchName}`, compareUrl };
        }

        return { ok: false, message: `Failed to push: ${pushResult.stderr}` };
      }),
  );

export const createPr = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreatePrInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("createPr", async () => {
        const p = await resolveProject(data.project);

        let headRef = data.branch;
        if (p.upstreamRemote !== "origin") {
          const originUrl = await tracedExeca("git", ["-C", p.dir, "remote", "get-url", "origin"], {
            reject: false,
          });
          if (originUrl.exitCode === 0) {
            const match = originUrl.stdout.match(/[/:]([^/]+)\/[^/]+?(?:\.git)?$/);
            if (match) {
              headRef = `${match[1]}:${data.branch}`;
            }
          }
        }

        const args = [
          "pr",
          "create",
          "--head",
          headRef,
          "--title",
          data.title,
          "--body",
          data.body ?? "",
        ];
        if (data.draft !== false) args.push("--draft");

        const result = await tracedExeca("gh", args, { cwd: p.dir, reject: false });

        if (result.exitCode === 0) {
          invalidatePrCache(data.project);
          const prUrl = result.stdout.trim();
          return { ok: true, message: `Created PR: ${prUrl}`, compareUrl: prUrl };
        }

        return { ok: false, message: `Failed to create PR: ${result.stderr}` };
      }),
  );

export interface TestJobStatus {
  id: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  message?: string;
}

export const testChild = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => TestChildInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<TestJobStatus> =>
      traced("testChild", async () => {
        const p = await resolveProject(data.project);

        const logResult = await tracedExeca(
          "git",
          ["-C", p.dir, "log", "-1", "--format=%h%x00%s%x00%D", data.sha],
          { reject: false },
        );
        const parts = logResult.stdout.split("\0");
        const shortSha = parts[0]?.trim() || data.sha.slice(0, 7);
        const subject = parts[1]?.trim() || "";
        const decoration = parts[2]?.trim() || "";
        const branchMatch = decoration.match(/(?:^|,\s*)(?:HEAD -> )?([^,\s][^,]*?)(?:\s*,|$)/);
        const branch = branchMatch?.[1]?.replace(/^refs\/heads\//, "") || undefined;

        // Validate transition: run_test can be done from ready_to_test or test_failed
        // We can't fully classify without more data, so we check the basic conditions
        // Only check dirty state if operating on HEAD
        const headSha = (
          await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false })
        ).stdout.trim();
        if (p.dirty && data.sha === headSha) {
          log.subprocess.debug(
            { project: data.project, sha: data.sha },
            "Cannot run test: project has local changes",
          );
        } else if (p.detachedHead && data.sha === headSha) {
          log.subprocess.debug(
            { project: data.project, sha: data.sha },
            "Cannot run test: project in detached HEAD state",
          );
        } else if (!p.hasTestConfigured) {
          log.subprocess.debug(
            { project: data.project, sha: data.sha },
            "Cannot run test: no test configured for project",
          );
        }

        const { enqueueTest } = await import("./test-queue.js");
        const job = enqueueTest(data.project, p.dir, data.sha, shortSha, subject, branch);
        return { id: job.id, status: job.status, message: job.message };
      }),
  );

export const testAllChildren = createServerFn({ method: "POST" }).handler(
  async (): Promise<TestJobStatus[]> =>
    traced("testAllChildren", async () => {
      const { enqueueTest } = await import("./test-queue.js");

      const projectsDirs = getProjectsDirs();
      const projects = await discoverAllProjects(projectsDirs);

      clearExpiredSnoozes();
      const snoozedSet = getSnoozedSet();

      const SKIP_PATTERNS = ["[skip]", "[pass]", "[stop]", "[fail]"];
      const queued: TestJobStatus[] = [];

      for (const p of projects) {
        if (!p.hasTestConfigured) continue;

        const headSha = p.dirty
          ? (
              await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false })
            ).stdout.trim()
          : undefined;

        const childShas = await getChildren(p.dir, p.upstreamRef);
        if (childShas.length === 0) continue;

        const testResults = getTestResultsForProject(p.name);

        const untested = childShas.filter((sha) => {
          if (testResults.has(sha)) return false;
          if (snoozedSet.has(`${p.name}:${sha}`)) return false;
          if (p.dirty && sha === headSha) return false;
          return true;
        });
        if (untested.length === 0) continue;

        const logResult = await tracedExeca(
          "git",
          ["-C", p.dir, "log", "--stdin", "--no-walk", "--format=%H%x00%h%x00%s%x00%B%x00%D%x1e"],
          { input: untested.join("\n"), reject: false },
        );
        if (logResult.exitCode !== 0) continue;

        for (const record of logResult.stdout.split("\x1e")) {
          const trimmed = record.replace(/^\n+/, "");
          if (!trimmed) continue;
          const splitFields = trimmed.split("\0");
          const sha = splitFields[0] ?? "";
          const shortSha = splitFields[1] ?? "";
          const subject = splitFields[2] ?? "";
          const fullMessage = splitFields[3] ?? "";
          const decoration = splitFields[4] ?? "";
          if (SKIP_PATTERNS.some((pat) => fullMessage.includes(pat))) continue;

          const branchMatch = decoration.match(/(?:^|,\s*)(?:HEAD -> )?([^,\s][^,]*?)(?:\s*,|$)/);
          const branch = branchMatch?.[1]?.replace(/^refs\/heads\//, "") || undefined;

          const job = enqueueTest(p.name, p.dir, sha, shortSha, subject, branch);
          queued.push({ id: job.id, status: job.status, message: job.message });
        }
      }
      return queued;
    }),
);

export const getProjectDir = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ project: z.string() }).parse(input))
  .handler(
    async ({ data }): Promise<string | null> =>
      traced("getProjectDir", async () => {
        try {
          return (await resolveProject(data.project)).dir;
        } catch (error: unknown) {
          log.general.error({ project: data.project, error }, "Project resolution failed");
          return null;
        }
      }),
  );

export interface FileDiff {
  oldFileName: string;
  newFileName: string;
  hunks: string;
  oldContent: string;
  newContent: string;
}

export const getCommitDiff = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ project: z.string(), sha: z.string() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<{ files: FileDiff[]; stat: string; subject: string }> =>
      traced("getCommitDiff", async () => {
        const p = await resolveProject(data.project);

        // Use -m --first-parent so merge commits produce a standard diff instead of combined format
        const [diffResult, statResult, subjectResult] = await Promise.all([
          tracedExeca("git", ["-C", p.dir, "show", "-m", "--first-parent", "--format=", data.sha], {
            reject: false,
          }),
          tracedExeca(
            "git",
            ["-C", p.dir, "show", "-m", "--first-parent", "--stat", "--format=", data.sha],
            {
              reject: false,
            },
          ),
          tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%s", data.sha], {
            reject: false,
          }),
        ]);

        if (diffResult.exitCode !== 0) {
          return { files: [], stat: "", subject: `git show failed: ${diffResult.stderr}` };
        }

        // Split raw diff into per-file chunks
        const rawDiff = diffResult.stdout;
        const fileDiffs = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

        const files: FileDiff[] = [];
        for (const chunk of fileDiffs) {
          const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*)/m);
          if (!headerMatch) continue;
          const oldFileName = headerMatch[1] ?? "";
          const newFileName = headerMatch[2] ?? "";

          // Pass full chunk including diff --git header — @git-diff-view/core needs it
          const hunks = chunk;

          // Detect new/deleted files from --- and +++ lines to avoid fetching nonexistent content
          const isNewFile = /^--- \/dev\/null$/m.test(chunk);
          const isDeletedFile = /^\+\+\+ \/dev\/null$/m.test(chunk);

          // Fetch old and new file content for syntax highlighting.
          // Use stripFinalNewline: false so the content matches the diff hunks exactly.
          const [oldResult, newResult] = await Promise.all([
            isNewFile
              ? { exitCode: 0, stdout: "" }
              : tracedExeca("git", ["-C", p.dir, "show", `${data.sha}^:${oldFileName}`], {
                  reject: false,
                  stripFinalNewline: false,
                }),
            isDeletedFile
              ? { exitCode: 0, stdout: "" }
              : tracedExeca("git", ["-C", p.dir, "show", `${data.sha}:${newFileName}`], {
                  reject: false,
                  stripFinalNewline: false,
                }),
          ]);

          files.push({
            oldFileName,
            newFileName,
            hunks,
            oldContent: oldResult.exitCode === 0 ? oldResult.stdout : "",
            newContent: newResult.exitCode === 0 ? newResult.stdout : "",
          });
        }

        return {
          files,
          stat: statResult.exitCode === 0 ? statResult.stdout : "",
          subject: subjectResult.exitCode === 0 ? subjectResult.stdout.trim() : "",
        };
      }),
  );

export const getWorkingTreeDiff = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ project: z.string() }).parse(input))
  .handler(
    async ({ data }): Promise<{ files: FileDiff[]; stat: string }> =>
      traced("getWorkingTreeDiff", async () => {
        const p = await resolveProject(data.project);

        // Show all uncommitted changes (staged + unstaged) relative to HEAD
        const [diffResult, statResult] = await Promise.all([
          tracedExeca("git", ["-C", p.dir, "diff", "HEAD"], { reject: false }),
          tracedExeca("git", ["-C", p.dir, "diff", "HEAD", "--stat"], { reject: false }),
        ]);

        if (diffResult.exitCode !== 0) {
          return { files: [], stat: "" };
        }

        const rawDiff = diffResult.stdout;
        const fileDiffs = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

        const files: FileDiff[] = [];
        for (const chunk of fileDiffs) {
          const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*)/m);
          if (!headerMatch) continue;
          const oldFileName = headerMatch[1] ?? "";
          const newFileName = headerMatch[2] ?? "";
          const isNewFile = /^--- \/dev\/null$/m.test(chunk);
          const isDeletedFile = /^\+\+\+ \/dev\/null$/m.test(chunk);

          const [oldResult, newResult] = await Promise.all([
            isNewFile
              ? { exitCode: 0, stdout: "" }
              : tracedExeca("git", ["-C", p.dir, "show", `HEAD:${oldFileName}`], {
                  reject: false,
                  stripFinalNewline: false,
                }),
            isDeletedFile
              ? { exitCode: 0, stdout: "" }
              : tracedExeca("git", ["-C", p.dir, "cat-file", "-p", `:${newFileName}`], {
                  reject: false,
                  stripFinalNewline: false,
                }).then((r) =>
                  r.exitCode === 0
                    ? r
                    : tracedExeca("git", ["-C", p.dir, "show", `HEAD:${newFileName}`], {
                        reject: false,
                        stripFinalNewline: false,
                      }),
                ),
          ]);

          files.push({
            oldFileName,
            newFileName,
            hunks: chunk,
            oldContent: oldResult.exitCode === 0 ? oldResult.stdout : "",
            newContent: newResult.exitCode === 0 ? newResult.stdout : "",
          });
        }

        return {
          files,
          stat: statResult.exitCode === 0 ? statResult.stdout : "",
        };
      }),
  );

export const commitWorkingTree = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ project: z.string() }).parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("commitWorkingTree", async () => {
        const p = await resolveProject(data.project);

        const result = await tracedExeca("claude", ["-p", "/git:commit"], {
          cwd: p.dir,
          reject: false,
          timeout: 120_000,
        });
        if (result.exitCode !== 0) {
          return {
            ok: false,
            message: result.stderr || result.stdout || `claude exited with code ${result.exitCode}`,
          };
        }
        return { ok: true, message: result.stdout };
      }),
  );

export const getTestLog = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ project: z.string(), sha: z.string() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<{ log: string | null; tail: string | null }> =>
      traced("getTestLog", async () => {
        const logDir = getTestLogDir(data.project);
        const logPath = path.join(logDir, `${data.sha}.log`);
        if (!fs.existsSync(logPath)) {
          return { log: null, tail: null };
        }
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.trimEnd().split("\n");
        const tail = lines.slice(-20).join("\n");
        return { log: content, tail };
      }),
  );

export const snoozeChildFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => SnoozeChildInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("snoozeChildFn", async () => {
        const p = await resolveProject(data.project);

        const logResult = await tracedExeca(
          "git",
          ["-C", p.dir, "log", "-1", "--format=%h%x00%s", data.sha],
          { reject: false },
        );
        const snoozeFields =
          logResult.exitCode === 0 ? logResult.stdout.split("\0") : [data.sha.slice(0, 7), ""];
        const shortSha = snoozeFields[0] ?? data.sha.slice(0, 7);
        const subject = snoozeFields[1] ?? "";

        // Validate transition: snooze is allowed from many states (ready_to_test, test_failed, ready_to_push, etc.)
        // We just log to ensure this was intended
        log.subprocess.debug({ project: data.project, sha: data.sha }, "Snoozing work item");

        snoozeItem(data.sha, data.project, shortSha, subject, data.until);
        return { ok: true, message: data.until ? `Snoozed until ${data.until}` : "On hold" };
      }),
  );

export const unsnoozeChildFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => UnsnoozeChildInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("unsnoozeChildFn", async () => {
        unsnoozeItem(data.sha, data.project);
        return { ok: true, message: "Unsnoozed" };
      }),
  );

export const getSnoozedList = createServerFn({ method: "GET" }).handler(
  async (): Promise<SnoozedChild[]> =>
    traced("getSnoozedList", async () => {
      clearExpiredSnoozes();
      return getAllSnoozedForDisplay();
    }),
);

export const getTestQueue = createServerFn({ method: "GET" }).handler(
  async (): Promise<TestQueueJob[]> =>
    traced("getTestQueue", async () => {
      const { getAllJobs } = await import("./test-queue.js");
      const jobs = getAllJobs();
      return Array.from(jobs.values()).map((j) => TestQueueJobSchema.parse(j));
    }),
);

export const cancelTestFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CancelTestInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("cancelTestFn", async () => {
        const { cancelTest } = await import("./test-queue.js");
        const result = cancelTest(data.id);
        return { ok: result.ok, message: result.message };
      }),
  );

export const refreshChild = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RefreshChildInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("refreshChild", async () => {
        invalidatePrCache(data.project);
        return { ok: true, message: `Refreshed ${data.project}` };
      }),
  );

export const getChildBySha = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) =>
    z.object({ project: z.string(), sha: z.string() }).parse(input),
  )
  .handler(
    async ({ data }): Promise<GitChildResult | null> =>
      traced("getChildBySha", async () => {
        let p: ProjectInfo;
        try {
          p = await resolveProject(data.project);
        } catch (error: unknown) {
          log.general.error({ project: data.project, error }, "Project resolution failed");
          return null;
        }

        const logResult = await tracedExeca(
          "git",
          ["-C", p.dir, "log", "-1", "--format=%H%x00%h%x00%s%x00%B%x00%ai%x00%D", data.sha],
          { reject: false },
        );
        if (logResult.exitCode !== 0) return null;

        const childFields = logResult.stdout.split("\0");
        const sha = childFields[0] ?? "";
        const shortSha = childFields[1] ?? "";
        const subject = childFields[2] ?? "";
        const fullMessage = childFields[3] ?? "";
        const date = childFields[4] ?? "";
        const decorations = childFields[5] ?? "";
        const skippable = isSkippable(fullMessage);

        const testResults = p.hasTestConfigured ? getTestResultsForProject(p.name) : new Map();
        const testStatus = skippable
          ? ("unknown" as const)
          : (testResults.get(sha) ?? ("unknown" as const));

        const upstreamSha = getCachedUpstreamSha(p.name);
        const ms = upstreamSha
          ? getCachedMergeStatuses(p.name, upstreamSha).find((s) => s.sha === sha)
          : undefined;

        const branch = parseBranch(decorations);

        let pushedToRemote = false;
        let localAhead: boolean | undefined;
        let prUrl: string | undefined;
        let prNumber: number | undefined;
        let reviewStatus: import("@wip/shared").ReviewStatus = "no_pr";
        let checkStatus: import("@wip/shared").CheckStatus = "none";
        let failedChecks: Array<{ name: string; url?: string }> | undefined;

        if (branch) {
          const [prStatuses, remoteBranchInfo] = await Promise.all([
            getPrStatuses(p.dir, p.name),
            getRemoteBranchInfo(p.dir),
          ]);
          prUrl = prStatuses.urls.get(branch);
          prNumber = prStatuses.prNumbers.get(branch);
          pushedToRemote = remoteBranchInfo.remoteBranches.has(branch);
          failedChecks = prStatuses.failedChecks.get(branch);
          reviewStatus = prStatuses.review.get(branch) ?? "no_pr";
          checkStatus = prStatuses.checks.get(branch) ?? "none";

          // Detect if local branch is ahead of remote tracking branch
          if (pushedToRemote) {
            const remoteRef = remoteBranchInfo.remoteBranchRefs.get(branch);
            if (remoteRef) {
              const remoteSha = await tracedExeca("git", ["-C", p.dir, "rev-parse", remoteRef], {
                reject: false,
              });
              localAhead =
                remoteSha.exitCode === 0 &&
                remoteSha.stdout.trim() !== "" &&
                remoteSha.stdout.trim() !== sha;
            }
          }
        }

        return {
          project: p.name,
          remote: p.remote,
          sha,
          shortSha,
          subject,
          date,
          branch,
          skippable,
          testStatus,
          checkStatus,
          pushedToRemote,
          localAhead,
          needsRebase: ms ? ms.commitsBehind > 0 : false,
          reviewStatus,
          prUrl,
          prNumber,
          failedChecks,
          commitsBehind: ms?.commitsBehind,
          commitsAhead: ms?.commitsAhead,
          rebaseable: ms?.rebaseable ?? undefined,
        };
      }),
  );

export const createBranch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateBranchInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("createBranch", async () => {
        const p = await resolveProject(data.project);

        const result = await tracedExeca(
          "git",
          ["-C", p.dir, "checkout", "-b", data.branchName, data.sha],
          {
            reject: false,
          },
        );

        if (result.exitCode === 0) {
          return { ok: true, message: `Created branch ${data.branchName}` };
        }

        return { ok: false, message: `Failed to create branch: ${result.stderr}` };
      }),
  );

export const deleteBranch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => DeleteBranchInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("deleteBranch", async () => {
        const p = await resolveProject(data.project);

        const result = await tracedExeca("git", ["-C", p.dir, "branch", "-D", data.branch], {
          reject: false,
        });

        if (result.exitCode === 0) {
          invalidatePrCache(data.project);
          return { ok: true, message: `Deleted branch ${data.branch}` };
        }

        return { ok: false, message: `Failed to delete branch: ${result.stderr}` };
      }),
  );

export const forcePush = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ForcePushInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("forcePush", async () => {
        const p = await resolveProject(data.project);

        const result = await tracedExeca(
          "git",
          [
            "-C",
            p.dir,
            "push",
            "--force-with-lease",
            p.upstreamRemote,
            `${data.branch}:refs/heads/${data.branch}`,
          ],
          { reject: false },
        );

        if (result.exitCode === 0) {
          invalidatePrCache(data.project);
          return { ok: true, message: `Force-pushed to ${data.branch}` };
        }

        return { ok: false, message: `Failed to force-push: ${result.stderr}` };
      }),
  );

export const mergePr = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => MergePrInputSchema.parse(input))
  .handler(async ({ data }): Promise<ActionResult> => {
    const p = await resolveProject(data.project);
    const { execa } = await import("execa");
    const env = await getMiseEnv(p.dir);
    const result = await execa(
      "gh",
      ["pr", "merge", String(data.prNumber), "--squash", "--delete-branch", "-R", p.remote],
      { reject: false, cwd: p.dir, env },
    );

    if (result.exitCode === 0) {
      invalidatePrCache(data.project);
      invalidateMergeStatus(data.project);
      return { ok: true, message: `Merged PR #${data.prNumber}` };
    }

    return { ok: false, message: `Failed to merge PR: ${result.stderr}` };
  });

export const renameBranch = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RenameBranchInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("renameBranch", async () => {
        const p = await resolveProject(data.project);

        const result = await tracedExeca(
          "git",
          ["-C", p.dir, "branch", "-m", data.oldBranch, data.newBranch],
          { reject: false },
        );

        if (result.exitCode === 0) {
          invalidatePrCache(data.project);
          return { ok: true, message: `Renamed ${data.oldBranch} → ${data.newBranch}` };
        }

        return { ok: false, message: `Failed to rename branch: ${result.stderr}` };
      }),
  );

export const applyFixes = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ApplyFixesInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("applyFixes", async () => {
        const p = await resolveProject(data.project);

        const env = await getMiseEnv(p.dir);

        await tracedExeca("git", ["-C", p.dir, "fetch", "origin"], { reject: false, env });

        const branchListResult = await tracedExeca(
          "git",
          ["-C", p.dir, "branch", "-r", "--list", `origin/fix-${data.prNumber}-*`],
          { reject: false, env },
        );
        if (branchListResult.exitCode !== 0 || !branchListResult.stdout.trim()) {
          return { ok: false, message: `No fix branches found for PR #${data.prNumber}` };
        }

        const fixBranches = branchListResult.stdout
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean);
        if (fixBranches.length === 0) {
          return { ok: false, message: `No fix branches found for PR #${data.prNumber}` };
        }

        const checkout = await tracedExeca("git", ["-C", p.dir, "checkout", data.branch], {
          reject: false,
          env,
        });
        if (checkout.exitCode !== 0) {
          return { ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}` };
        }

        const appliedFixes: string[] = [];
        for (const fixBranch of fixBranches) {
          const cp = await tracedExeca(
            "git",
            ["-C", p.dir, "cherry-pick", "--no-commit", fixBranch],
            {
              reject: false,
              env,
            },
          );
          if (cp.exitCode !== 0) {
            await tracedExeca("git", ["-C", p.dir, "cherry-pick", "--abort"], {
              reject: false,
              env,
            });
            await tracedExeca("git", ["-C", p.dir, "reset", "--hard", "HEAD"], {
              reject: false,
              env,
            });
            continue;
          }
          appliedFixes.push(fixBranch.replace("origin/", ""));
        }

        if (appliedFixes.length === 0) {
          return {
            ok: false,
            message: "All fix cherry-picks had conflicts — manual resolution needed",
          };
        }

        const diffIndex = await tracedExeca("git", ["-C", p.dir, "diff", "--cached", "--quiet"], {
          reject: false,
          env,
        });
        if (diffIndex.exitCode === 0) {
          return { ok: false, message: "Fix branches had no changes to apply" };
        }

        const amend = await tracedExeca("git", ["-C", p.dir, "commit", "--amend", "--no-edit"], {
          reject: false,
          env,
        });
        if (amend.exitCode !== 0) {
          return { ok: false, message: `Failed to amend commit: ${amend.stderr}` };
        }

        const push = await tracedExeca(
          "git",
          ["-C", p.dir, "push", "origin", `${data.branch}:${data.branch}`, "--force-with-lease"],
          { reject: false, env },
        );
        if (push.exitCode !== 0) {
          return { ok: false, message: `Amended commit but failed to push: ${push.stderr}` };
        }

        invalidatePrCache(data.project);
        return {
          ok: true,
          message: `Applied fixes from ${appliedFixes.join(", ")} and force-pushed to ${data.branch}`,
        };
      }),
  );

export const rebaseLocal = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RebaseLocalInputSchema.parse(input))
  .handler(
    async ({ data }): Promise<ActionResult> =>
      traced("rebaseLocal", async () => {
        const p = await resolveProject(data.project);

        const env = await getMiseEnv(p.dir);

        await tracedExeca(
          "git",
          ["-C", p.dir, "fetch", p.upstreamRemote, p.upstreamBranch ?? "main"],
          { reject: false, env },
        );

        // Validate transition: rebase is allowed from needs_rebase state
        // Rebasing requires a clean working directory (all commits), unlike test/push which work on any commit
        if (p.dirty) {
          log.subprocess.debug(
            { project: data.project, branch: data.branch },
            "Warning: rebasing with dirty working directory",
          );
        }

        const checkout = await tracedExeca("git", ["-C", p.dir, "checkout", data.branch], {
          reject: false,
          env,
        });
        if (checkout.exitCode !== 0) {
          return { ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}` };
        }

        const branchSha = (
          await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false, env })
        ).stdout.trim();
        const rebase = await tracedExeca("git", ["-C", p.dir, "rebase", p.upstreamRef], {
          reject: false,
          env,
        });
        if (rebase.exitCode !== 0) {
          await tracedExeca("git", ["-C", p.dir, "rebase", "--abort"], { reject: false, env });
          const upstreamSha = getCachedUpstreamSha(data.project);
          if (upstreamSha && branchSha) {
            cacheMergeStatus(data.project, branchSha, upstreamSha, 0, 1, false);
          }
          return { ok: false, message: `Rebase failed with conflicts: ${rebase.stderr}` };
        }

        const push = await tracedExeca(
          "git",
          ["-C", p.dir, "push", p.remote, `${data.branch}:${data.branch}`, "--force-with-lease"],
          { reject: false, env },
        );
        if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
          return { ok: false, message: `Rebased but failed to push: ${push.stderr}` };
        }

        invalidatePrCache(data.project);
        invalidateMergeStatus(data.project);
        return { ok: true, message: `Rebased ${data.branch} onto ${p.upstreamRef}` };
      }),
  );

export const rebaseAllBranches = createServerFn({ method: "POST" }).handler(
  async (): Promise<ActionResult> =>
    traced("rebaseAllBranches", async () => {
      const projectsDirs = getProjectsDirs();
      const projects = await discoverAllProjects(projectsDirs);

      const results: string[] = [];
      const errors: string[] = [];

      for (const p of projects) {
        if (p.dirty || !p.hasTestConfigured) continue;
        const env = await getMiseEnv(p.dir);

        await tracedExeca("git", ["-C", p.dir, "fetch", p.upstreamRemote], {
          reject: false,
          env,
        });

        const branchList = await tracedExeca(
          "git",
          [
            "-C",
            p.dir,
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/",
            "--sort=-committerdate",
            `--no-contains=${p.upstreamRef}`,
          ],
          { reject: false, env },
        );
        if (branchList.exitCode !== 0 || !branchList.stdout.trim()) continue;

        const branches = branchList.stdout
          .split("\n")
          .filter(Boolean)
          .filter((b) => !/^(main|master)$/.test(b));

        for (const branch of branches) {
          const checkout = await tracedExeca("git", ["-C", p.dir, "checkout", branch], {
            reject: false,
            env,
          });
          if (checkout.exitCode !== 0) continue;

          const branchSha = (
            await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], { reject: false, env })
          ).stdout.trim();
          const rebase = await tracedExeca(
            "git",
            ["-C", p.dir, "rebase", "--rebase-merges", "--update-refs", p.upstreamRef],
            { reject: false, env },
          );
          if (rebase.exitCode !== 0) {
            await tracedExeca("git", ["-C", p.dir, "rebase", "--abort"], { reject: false, env });
            const upstreamSha = getCachedUpstreamSha(p.name);
            if (upstreamSha && branchSha) {
              cacheMergeStatus(p.name, branchSha, upstreamSha, 0, 1, false);
            }
            errors.push(`${p.name}/${branch}: conflicts`);
            continue;
          }

          const push = await tracedExeca(
            "git",
            ["-C", p.dir, "push", p.remote, `${branch}:${branch}`, "--force-with-lease"],
            { reject: false, env },
          );
          if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
            errors.push(`${p.name}/${branch}: push failed`);
            continue;
          }

          results.push(`${p.name}/${branch}`);
        }

        await tracedExeca("git", ["-C", p.dir, "checkout", p.upstreamBranch ?? "main"], {
          reject: false,
          env,
        });
        invalidatePrCache(p.name);
        invalidateMergeStatus(p.name);
      }

      if (results.length === 0 && errors.length === 0) {
        return { ok: true, message: "All branches are up to date" };
      }
      const msg =
        results.length > 0
          ? `Rebased ${results.length} branch${results.length > 1 ? "es" : ""}`
          : "";
      const errMsg = errors.length > 0 ? `${errors.length} failed: ${errors.join(", ")}` : "";
      return { ok: errors.length === 0, message: [msg, errMsg].filter(Boolean).join(". ") };
    }),
);

export const refreshAll = createServerFn({ method: "POST" }).handler(
  async (): Promise<ActionResult> =>
    traced("refreshAll", async () => {
      cachedProjects = null;
      cachedProjectsTime = 0;
      invalidateIssuesCache();
      invalidateProjectItemsCache();
      // Re-populate the project cache and invalidate PR caches
      const projects = await refreshProjectCache();
      for (const p of projects) {
        invalidatePrCache(p.name);
      }
      return { ok: true, message: "All caches invalidated" };
    }),
);
