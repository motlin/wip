import {createServerFn} from "@tanstack/react-start";
import {
	captureLogs,
	clearExpiredSnoozes,
	discoverAllProjects,
	fetchAssignedIssues,
	fetchAllProjectItems,
	findIncompleteTodoTasks,
	getAllSnoozedForDisplay,
	getBranchNames,
	getChildCommits,
	getMiseEnv,
	getPrStatuses,
	getProjectsDirs,
	getRemoteBranchInfo,
	getSnoozedSet,
	getTestLogDir,
	invalidatePrCache,
	invalidateIssuesCache,
	invalidateProjectItemsCache,
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
	getCachedChildren,
	cacheChildren,
	invalidateChildrenCache,
	isCacheFresh,
	getCacheFreshnessByPrefix,
	getGitHubRateLimitState,
	getCachedTodos,
	cacheTodos,
	invalidateTodosCache,
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
	type SnoozedChild,
	PushChildInputSchema,
	type PushChildInput,
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
	type RebaseLocalInput,
	TaskQueueJobSchema,
	type TaskQueueJob,
	RunClaudeCommandInputSchema,
	planProject,
	resolveAdvanceConcurrency,
	matchesFilters,
} from "@wip/shared";

import {log} from "@wip/shared/services/logger-pino.js";
import {enqueueRefresh} from "./refresh-scheduler.js";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {getTracer} from "@wip/shared/services/telemetry.js";
import {classifyGitChild} from "./classify.js";
import type {EnqueueRebaseOptions} from "./task-queue.js";
import {z} from "zod";
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

/**
 * Wraps an action handler so that any subprocess/general logs emitted during
 * the call are attached to the returned ActionResult. The client uses these
 * entries to show toasts to the user.
 */
async function tracedAction(name: string, fn: () => Promise<ActionResult>): Promise<ActionResult> {
	const {result, logs} = await captureLogs(() => traced(name, fn), {
		categories: ["subprocess", "general"],
	});
	if (logs.length === 0) return result;
	return {
		...result,
		logs: logs.map((e) => ({time: e.time, level: e.level, category: e.category, msg: e.msg})),
	};
}

export type {ActionResult, SnoozedChild, GitChildResult};

export type ProjectChildrenResult = GitChildResult[];

let cachedProjects: ProjectInfo[] | null = null;
let cachedProjectsTime = 0;
const PROJECT_CACHE_TTL = 5 * 60 * 1000;
let discoverInFlight: Promise<ProjectInfo[]> | null = null;

/** Test-only: populate the in-memory project cache so resolveProject() works without filesystem discovery. */
export function seedProjectCache(projects: ProjectInfo[]): void {
	cachedProjects = projects;
	cachedProjectsTime = Date.now();
	discoverInFlight = null;
}

/** Test-only: clear the in-memory project cache. */
export function resetProjectCache(): void {
	cachedProjects = null;
	cachedProjectsTime = 0;
	discoverInFlight = null;
}

async function refreshProjectCache(): Promise<ProjectInfo[]> {
	if (discoverInFlight) return discoverInFlight;
	const projectsDirs = getProjectsDirs();
	discoverInFlight = discoverAllProjects(projectsDirs).then(async (projects) => {
		cachedProjects = projects;
		cachedProjectsTime = Date.now();
		discoverInFlight = null;
		setCachedProjectList(projects);
		const {projectEmitter} = await import("./project-events.js");
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
		enqueueRefresh({
			kind: "discovery",
			project: "",
			run: async () => {
				await refreshProjectCache();
			},
		});
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

export const getProjects = createServerFn({method: "GET"}).handler(async () =>
	traced("getProjects", async () => {
		await ensureProjects();
		return cachedProjects!;
	}),
);

const inflightChildrenRefresh = new Map<string, Promise<ProjectChildrenResult>>();

export async function refreshProjectChildren(projectName: string): Promise<ProjectChildrenResult> {
	const existing = inflightChildrenRefresh.get(projectName);
	if (existing) return existing;

	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	const promise = suppressWatcherEvents(projectName, () =>
		traced("refreshProjectChildren", async () => {
			let p: ProjectInfo;
			try {
				p = await resolveProject(projectName);
			} catch (error: unknown) {
				log.general.error({project: projectName, error}, "Project resolution failed");
				return [];
			}

			const prStatuses = await getPrStatuses(p.dir, p.name, p.upstreamRemote);

			const upstreamSha = getCachedUpstreamSha(p.name);
			const mergeStatusMap = new Map<
				string,
				{commitsAhead: number; commitsBehind: number; rebaseable: boolean | null}
			>();
			if (upstreamSha) {
				for (const ms of getCachedMergeStatuses(p.name, upstreamSha)) {
					mergeStatusMap.set(ms.sha, ms);
				}
			}

			const [children, remoteBranchInfo] = await Promise.all([
				getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name, mergeStatusMap),
				getRemoteBranchInfo(p.dir),
			]);

			// Discover branches that need rebase (upstream is not an ancestor)
			const needsRebaseBranches = await getNeedsRebaseBranches(
				p.dir,
				p.upstreamRef,
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
				.map((c) => ({sha: c.sha, project: p.name, subject: c.subject, dir: p.dir}));
			const cachedNames = namingKeys.length > 0 ? getBranchNames(namingKeys) : new Map<string, string>();

			// Fire off background naming for any uncached items
			const uncachedKeys = namingKeys.filter((k) => !cachedNames.has(`${k.project}:${k.sha}`));
			if (uncachedKeys.length > 0) {
				suggestBranchNames(uncachedKeys).catch(() => {});
			}

			const headSha = (
				await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false})
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
					originRemote: p.originRemote,
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
					rebaseable: ms?.rebaseable ?? (child.rebaseable === undefined ? undefined : child.rebaseable),
					mergeStateStatus: child.mergeStateStatus,
					alreadyOnRemote: child.alreadyOnRemote,
					failureTail,
					suggestedBranch:
						child.branch && !defaultBranchPattern.test(child.branch) ? undefined : suggestedBranch,
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

			cacheChildren(projectName, results);
			const {childrenEmitter} = await import("./children-events.js");
			childrenEmitter.emit("children", {project: projectName, children: results});
			return results;
		}),
	);

	inflightChildrenRefresh.set(projectName, promise);
	try {
		return await promise;
	} finally {
		inflightChildrenRefresh.delete(projectName);
	}
}

export const CHILDREN_CACHE_TTL_MS = 10 * 60 * 1000;
export const TODOS_CACHE_TTL_MS = 10 * 60 * 1000;

export async function getProjectChildrenHandler(project: string): Promise<ProjectChildrenResult> {
	return traced("getProjectChildren", async () => {
		const cached = getCachedChildren(project);
		if (cached) {
			if (isCacheFresh(`children:${project}`, CHILDREN_CACHE_TTL_MS)) return cached;
			enqueueRefresh({
				kind: "children",
				project,
				run: async () => {
					await refreshProjectChildren(project);
				},
			});
			return cached;
		}
		return refreshProjectChildren(project);
	});
}

export const getProjectChildren = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}) => getProjectChildrenHandler(data.project));

const inflightTodosRefresh = new Map<string, Promise<SharedTodoItem[]>>();

export async function refreshProjectTodos(projectName: string): Promise<SharedTodoItem[]> {
	const existing = inflightTodosRefresh.get(projectName);
	if (existing) return existing;

	const promise = traced("refreshProjectTodos", async () => {
		let p: ProjectInfo;
		try {
			p = await resolveProject(projectName);
		} catch (error: unknown) {
			log.general.error({project: projectName, error}, "Project resolution failed");
			return [];
		}

		const tasks = findIncompleteTodoTasks(p.dir);
		const todos = tasks.map((task) => ({
			project: p.name,
			title: task.text,
			sourceFile: task.sourceFile,
			sourceLabel: path.relative(p.dir, task.sourceFile),
		}));
		cacheTodos(projectName, todos);
		const {todoEmitter} = await import("./todo-events.js");
		todoEmitter.emit("todos", {project: projectName, todos});
		return todos;
	});

	inflightTodosRefresh.set(projectName, promise);
	try {
		return await promise;
	} finally {
		inflightTodosRefresh.delete(projectName);
	}
}

export const getProjectTodos = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<SharedTodoItem[]> =>
			traced("getProjectTodos", async () => {
				const cached = getCachedTodos(data.project);
				if (cached) {
					if (isCacheFresh(`todos:${data.project}`, TODOS_CACHE_TTL_MS)) return cached;
					enqueueRefresh({
						kind: "todos",
						project: data.project,
						run: async () => {
							await refreshProjectTodos(data.project);
						},
					});
					return cached;
				}
				return refreshProjectTodos(data.project);
			}),
	);

export const getIssues = createServerFn({method: "GET"}).handler(async () =>
	traced("getIssues", async () => {
		return fetchAssignedIssues();
	}),
);

export const getProjectItemsFn = createServerFn({method: "GET"}).handler(async () =>
	traced("getProjectItemsFn", async () => {
		return fetchAllProjectItems();
	}),
);

export const getIssueByNumber = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), number: z.number()}).parse(input))
	.handler(
		async ({data}): Promise<IssueResult | null> =>
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

export const getProjectItemByNumber = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), number: z.number()}).parse(input))
	.handler(
		async ({data}): Promise<ProjectItemResult | null> =>
			traced("getProjectItemByNumber", async () => {
				const items = await fetchAllProjectItems();
				for (const item of items) {
					if (item.number !== data.number) continue;
					const repoName = item.repository ?? "unknown";
					const p = cachedProjects?.find((proj) => proj.remote.toLowerCase() === repoName.toLowerCase());
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

export async function pushChildHandler(data: PushChildInput): Promise<TestJobStatus> {
	return traced("pushChild", async () => {
		const p = await resolveProject(data.project);

		const logResult = await tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%h%x00%s", data.sha], {
			reject: false,
		});
		const logFields = logResult.stdout.split("\0");
		const shortSha = logFields[0] ?? "";
		const subject = logFields[1] ?? "";

		const {getBranchName} = await import("@wip/shared");
		const branchName =
			data.branch ??
			getBranchName(data.sha, p.name) ??
			subject
				.toLowerCase()
				.replaceAll(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "");

		const createBranch = !data.branch;

		const {enqueuePush} = await import("./task-queue.js");
		const task = enqueuePush({
			project: data.project,
			projectDir: p.dir,
			sha: data.sha,
			shortSha,
			subject,
			branch: branchName,
			upstreamRemote: p.upstreamRemote,
			remote: p.remote,
			createBranch,
		});
		return {id: task.id, status: task.status, message: task.message};
	});
}

export const pushChild = createServerFn({method: "POST"})
	.validator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}) => pushChildHandler(data));

export const createPr = createServerFn({method: "POST"})
	.validator((input: unknown) => CreatePrInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("createPr", async () => {
				const p = await resolveProject(data.project);

				let headRefName = data.branch;
				if (p.upstreamRemote !== "origin") {
					const originUrl = await tracedExeca("git", ["-C", p.dir, "remote", "get-url", "origin"], {
						reject: false,
					});
					if (originUrl.exitCode === 0) {
						const match = originUrl.stdout.match(/[/:]([^/]+)\/[^/]+?(?:\.git)?$/);
						if (match) {
							headRefName = `${match[1]}:${data.branch}`;
						}
					}
				}

				const [owner, name] = p.remote.split("/");
				if (!owner || !name) {
					return {ok: false, message: `Could not parse owner/repo from remote: ${p.remote}`};
				}

				const {createPullRequest} = await import("@wip/shared");
				const result = await createPullRequest({
					owner,
					name,
					baseRefName: p.upstreamBranch,
					headRefName,
					title: data.title,
					body: data.body ?? "",
					draft: data.draft !== false,
				});

				if (result.ok) {
					invalidatePrCache(data.project);
					invalidateChildrenCache(data.project);
					return {ok: true, message: `Created PR: ${result.prUrl}`, compareUrl: result.prUrl};
				}

				return {ok: false, message: result.message};
			}),
	);

export interface TestJobStatus {
	id: string;
	status: "queued" | "running" | "passed" | "failed" | "cancelled";
	message?: string;
}

export const testChild = createServerFn({method: "POST"})
	.validator((input: unknown) => TestChildInputSchema.parse(input))
	.handler(
		async ({data}): Promise<TestJobStatus> =>
			traced("testChild", async () => {
				const p = await resolveProject(data.project);

				const logResult = await tracedExeca(
					"git",
					["-C", p.dir, "log", "-1", "--format=%h%x00%s%x00%D", data.sha],
					{reject: false},
				);
				const parts = logResult.stdout.split("\0");
				const shortSha = parts[0]?.trim() || data.sha.slice(0, 7);
				const subject = parts[1]?.trim() || "";
				const decoration = parts[2]?.trim() || "";
				const branchMatch = decoration.match(/(?:^|,\s*)(?:HEAD -> )?([^,\s][^,]*?)(?:\s*,|$)/);
				const branch = branchMatch?.[1]?.replace(/^refs\/heads\//, "") || undefined;

				// Reject invalid transitions loudly — the card renders the thrown
				// message, instead of enqueueing a test that cannot run.
				// Only check dirty state if operating on HEAD.
				const headSha = (
					await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false})
				).stdout.trim();
				if (p.dirty && data.sha === headSha) {
					throw new Error(
						`Cannot run test: ${data.project} has uncommitted changes — commit them first (cd ${p.dir} && claude --permission-mode acceptEdits /git:commit)`,
					);
				}
				if (p.detachedHead && data.sha === headSha) {
					throw new Error(`Cannot run test: ${data.project} is in detached HEAD state`);
				}
				if (!p.hasTestConfigured) {
					throw new Error(`Cannot run test: no test configured for ${data.project}`);
				}

				const {enqueueTest} = await import("./task-queue.js");
				const job = enqueueTest(data.project, p.dir, data.sha, shortSha, subject, branch);
				return {id: job.id, status: job.status, message: job.message};
			}),
	);

const backgroundEnqueues = new Set<Promise<unknown>>();

// Run a heavy discover-and-enqueue routine in the background so the POST returns
// immediately. Tasks stream to the client via the task-queue SSE feed as they are
// enqueued, instead of the click blocking until every project has been scanned.
function launchBackgroundEnqueue(name: string, run: () => Promise<unknown>): void {
	const promise = run()
		.catch((err) => {
			log.general.error({err}, `${name} background enqueue failed`);
		})
		.finally(() => {
			backgroundEnqueues.delete(promise);
		});
	backgroundEnqueues.add(promise);
}

interface PlannedTest {
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	branch?: string;
}

/**
 * How planners read a project's children. Count queries use cached children
 * only (no subprocess or API work on a GET path); the click handlers use the
 * regular cached-or-refresh read so what gets enqueued reflects reality.
 */
type ChildrenReader = (project: ProjectInfo) => Promise<ProjectChildrenResult>;

const readCachedChildren: ChildrenReader = async (p) => getCachedChildren(p.name) ?? [];
const readFreshChildren: ChildrenReader = async (p) => getProjectChildrenHandler(p.name);

// Discover the untested child commits that "Run All Tests" would enqueue, without
// touching the task queue. Uses the same classification as the queue UI so the
// button's (N) always matches what a click actually queues.
async function planTestAll(readChildren: ChildrenReader): Promise<PlannedTest[]> {
	await ensureProjects();
	const projects = cachedProjects!;

	const planned: PlannedTest[] = [];
	for (const p of projects) {
		if (!p.hasTestConfigured) continue;

		const children = await readChildren(p);
		for (const child of children) {
			if (classifyGitChild(child, p) !== "ready_to_test") continue;
			planned.push({
				project: p.name,
				projectDir: p.dir,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				branch: child.branch,
			});
		}
	}
	return planned;
}

async function testAllChildrenHandler(): Promise<TestJobStatus[]> {
	return traced("testAllChildren", async () => {
		const {enqueueTest} = await import("./task-queue.js");
		const planned = await planTestAll(readFreshChildren);
		return planned.map((t) => {
			const job = enqueueTest(t.project, t.projectDir, t.sha, t.shortSha, t.subject, t.branch);
			return {id: job.id, status: job.status, message: job.message};
		});
	});
}

export const testAllChildren = createServerFn({method: "POST"}).handler(async () => {
	launchBackgroundEnqueue("testAllChildren", testAllChildrenHandler);
	return {started: true} as const;
});

export interface FileDiff {
	oldFileName: string;
	newFileName: string;
	hunks: string;
	oldContent: string;
	newContent: string;
}

export const getCommitDiff = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{files: FileDiff[]; stat: string; subject: string}> =>
			traced("getCommitDiff", async () => {
				const p = await resolveProject(data.project);

				// Use -m --first-parent so merge commits produce a standard diff instead of combined format
				const [diffResult, statResult, subjectResult] = await Promise.all([
					tracedExeca("git", ["-C", p.dir, "show", "-m", "--first-parent", "--format=", data.sha], {
						reject: false,
					}),
					tracedExeca("git", ["-C", p.dir, "show", "-m", "--first-parent", "--stat", "--format=", data.sha], {
						reject: false,
					}),
					tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%s", data.sha], {
						reject: false,
					}),
				]);

				if (diffResult.exitCode !== 0) {
					return {files: [], stat: "", subject: `git show failed: ${diffResult.stderr}`};
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
							? {exitCode: 0, stdout: ""}
							: tracedExeca("git", ["-C", p.dir, "show", `${data.sha}^:${oldFileName}`], {
									reject: false,
									stripFinalNewline: false,
								}),
						isDeletedFile
							? {exitCode: 0, stdout: ""}
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

export const getWorkingTreeDiff = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{files: FileDiff[]; stat: string}> =>
			traced("getWorkingTreeDiff", async () => {
				const p = await resolveProject(data.project);

				// Show all uncommitted changes (staged + unstaged) relative to HEAD
				const [diffResult, statResult] = await Promise.all([
					tracedExeca("git", ["-C", p.dir, "diff", "HEAD"], {reject: false}),
					tracedExeca("git", ["-C", p.dir, "diff", "HEAD", "--stat"], {reject: false}),
				]);

				if (diffResult.exitCode !== 0) {
					return {files: [], stat: ""};
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
							? {exitCode: 0, stdout: ""}
							: tracedExeca("git", ["-C", p.dir, "show", `HEAD:${oldFileName}`], {
									reject: false,
									stripFinalNewline: false,
								}),
						isDeletedFile
							? {exitCode: 0, stdout: ""}
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

export const commitWorkingTree = createServerFn({method: "POST"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("commitWorkingTree", async () => {
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
				return {ok: true, message: result.stdout};
			}),
	);

export const getTestLog = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{log: string | null; tail: string | null}> =>
			traced("getTestLog", async () => {
				const logDir = getTestLogDir(data.project);
				const logPath = path.join(logDir, `${data.sha}.log`);
				if (!fs.existsSync(logPath)) {
					return {log: null, tail: null};
				}
				const content = fs.readFileSync(logPath, "utf-8");
				const lines = content.trimEnd().split("\n");
				const tail = lines.slice(-20).join("\n");
				return {log: content, tail};
			}),
	);

export const snoozeChildFn = createServerFn({method: "POST"})
	.validator((input: unknown) => SnoozeChildInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("snoozeChildFn", async () => {
				const p = await resolveProject(data.project);

				const logResult = await tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%h%x00%s", data.sha], {
					reject: false,
				});
				const snoozeFields =
					logResult.exitCode === 0 ? logResult.stdout.split("\0") : [data.sha.slice(0, 7), ""];
				const shortSha = snoozeFields[0] ?? data.sha.slice(0, 7);
				const subject = snoozeFields[1] ?? "";

				// Validate transition: snooze is allowed from many states (ready_to_test, test_failed, ready_to_push, etc.)
				// We just log to ensure this was intended
				log.subprocess.debug({project: data.project, sha: data.sha}, "Snoozing work item");

				snoozeItem(data.sha, data.project, shortSha, subject, data.until);
				return {ok: true, message: data.until ? `Snoozed until ${data.until}` : "On hold"};
			}),
	);

export const unsnoozeChildFn = createServerFn({method: "POST"})
	.validator((input: unknown) => UnsnoozeChildInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("unsnoozeChildFn", async () => {
				unsnoozeItem(data.sha, data.project);
				return {ok: true, message: "Unsnoozed"};
			}),
	);

export const getSnoozedList = createServerFn({method: "GET"}).handler(
	async (): Promise<SnoozedChild[]> =>
		traced("getSnoozedList", async () => {
			clearExpiredSnoozes();
			return getAllSnoozedForDisplay();
		}),
);

export const getTaskQueue = createServerFn({method: "GET"}).handler(
	async (): Promise<TaskQueueJob[]> =>
		traced("getTaskQueue", async () => {
			const {getAllTasks} = await import("./task-queue.js");
			const tasks = getAllTasks();
			return Array.from(tasks.values()).map((t) => TaskQueueJobSchema.parse(t));
		}),
);

export const cancelTestFn = createServerFn({method: "POST"})
	.validator((input: unknown) => CancelTestInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("cancelTestFn", async () => {
				const {cancelTest} = await import("./task-queue.js");
				const result = cancelTest(data.id);
				return {ok: result.ok, message: result.message};
			}),
	);

export const runClaudeCommand = createServerFn({method: "POST"})
	.validator((input: unknown) => RunClaudeCommandInputSchema.parse(input))
	.handler(
		async ({data}): Promise<TestJobStatus> =>
			traced("runClaudeCommand", async () => {
				const p = await resolveProject(data.project);
				const {enqueueTask} = await import("./task-queue.js");
				const task = enqueueTask(
					"claude",
					data.project,
					p.dir,
					data.sha,
					data.sha.slice(0, 7),
					undefined,
					data.branch,
					data.command,
				);
				return {id: task.id, status: task.status, message: task.message};
			}),
	);

export const refreshChild = createServerFn({method: "POST"})
	.validator((input: unknown) => RefreshChildInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("refreshChild", async () => {
				invalidatePrCache(data.project);
				invalidateChildrenCache(data.project);
				// Do the refresh before answering, so "Refreshed" is true and the
				// client's follow-up read returns the fresh cache.
				await refreshProjectChildren(data.project);
				return {ok: true, message: `Refreshed ${data.project}`};
			}),
	);

export const createBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => CreateBranchInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("createBranch", async () => {
				const p = await resolveProject(data.project);

				const result = await tracedExeca("git", ["-C", p.dir, "checkout", "-b", data.branchName, data.sha], {
					reject: false,
				});

				if (result.exitCode === 0) {
					return {ok: true, message: `Created branch ${data.branchName}`};
				}

				return {ok: false, message: `Failed to create branch: ${result.stderr}`};
			}),
	);

export const deleteBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => DeleteBranchInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("deleteBranch", async () => {
				const p = await resolveProject(data.project);

				const result = await tracedExeca("git", ["-C", p.dir, "branch", "-D", data.branch], {
					reject: false,
				});

				if (result.exitCode === 0) {
					invalidatePrCache(data.project);
					invalidateChildrenCache(data.project);
					return {ok: true, message: `Deleted branch ${data.branch}`};
				}

				return {ok: false, message: `Failed to delete branch: ${result.stderr}`};
			}),
	);

export const forcePush = createServerFn({method: "POST"})
	.validator((input: unknown) => ForcePushInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("forcePush", async () => {
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
					{reject: false},
				);

				if (result.exitCode === 0) {
					invalidatePrCache(data.project);
					invalidateChildrenCache(data.project);
					return {ok: true, message: `Force-pushed to ${data.branch}`};
				}

				return {ok: false, message: `Failed to force-push: ${result.stderr}`};
			}),
	);

export const mergePr = createServerFn({method: "POST"})
	.validator((input: unknown) => MergePrInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("mergePr", async () => {
				const p = await resolveProject(data.project);
				const {execa} = await import("execa");
				const env = await getMiseEnv(p.dir);
				const result = await execa(
					"gh",
					["pr", "merge", String(data.prNumber), "--squash", "--delete-branch", "-R", p.remote],
					{reject: false, cwd: p.dir, env},
				);

				if (result.exitCode === 0) {
					invalidatePrCache(data.project);
					invalidateMergeStatus(data.project);
					return {ok: true, message: `Merged PR #${data.prNumber}`};
				}

				return {ok: false, message: `Failed to merge PR: ${result.stderr}`};
			}),
	);

export const renameBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => RenameBranchInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("renameBranch", async () => {
				const p = await resolveProject(data.project);

				const result = await tracedExeca("git", ["-C", p.dir, "branch", "-m", data.oldBranch, data.newBranch], {
					reject: false,
				});

				if (result.exitCode === 0) {
					invalidatePrCache(data.project);
					invalidateChildrenCache(data.project);
					return {ok: true, message: `Renamed ${data.oldBranch} → ${data.newBranch}`};
				}

				return {ok: false, message: `Failed to rename branch: ${result.stderr}`};
			}),
	);

export const applyFixes = createServerFn({method: "POST"})
	.validator((input: unknown) => ApplyFixesInputSchema.parse(input))
	.handler(
		async ({data}): Promise<ActionResult> =>
			tracedAction("applyFixes", async () => {
				const p = await resolveProject(data.project);

				const env = await getMiseEnv(p.dir);

				await tracedExeca("git", ["-C", p.dir, "fetch", "origin"], {reject: false, env});

				const branchListResult = await tracedExeca(
					"git",
					["-C", p.dir, "branch", "-r", "--list", `origin/fix-${data.prNumber}-*`],
					{reject: false, env},
				);
				if (branchListResult.exitCode !== 0 || !branchListResult.stdout.trim()) {
					return {ok: false, message: `No fix branches found for PR #${data.prNumber}`};
				}

				const fixBranches = branchListResult.stdout
					.split("\n")
					.map((b) => b.trim())
					.filter(Boolean);
				if (fixBranches.length === 0) {
					return {ok: false, message: `No fix branches found for PR #${data.prNumber}`};
				}

				const checkout = await tracedExeca("git", ["-C", p.dir, "checkout", data.branch], {
					reject: false,
					env,
				});
				if (checkout.exitCode !== 0) {
					return {ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}`};
				}

				const appliedFixes: string[] = [];
				for (const fixBranch of fixBranches) {
					const cp = await tracedExeca("git", ["-C", p.dir, "cherry-pick", "--no-commit", fixBranch], {
						reject: false,
						env,
					});
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
					return {ok: false, message: "Fix branches had no changes to apply"};
				}

				const amend = await tracedExeca("git", ["-C", p.dir, "commit", "--amend", "--no-edit"], {
					reject: false,
					env,
				});
				if (amend.exitCode !== 0) {
					return {ok: false, message: `Failed to amend commit: ${amend.stderr}`};
				}

				const push = await tracedExeca(
					"git",
					["-C", p.dir, "push", "origin", `${data.branch}:${data.branch}`, "--force-with-lease"],
					{reject: false, env},
				);
				if (push.exitCode !== 0) {
					return {ok: false, message: `Amended commit but failed to push: ${push.stderr}`};
				}

				invalidatePrCache(data.project);
				invalidateChildrenCache(data.project);
				return {
					ok: true,
					message: `Applied fixes from ${appliedFixes.join(", ")} and force-pushed to ${data.branch}`,
				};
			}),
	);

export async function rebaseLocalHandler(data: RebaseLocalInput): Promise<ActionResult> {
	return tracedAction("rebaseLocal", async () => {
		const p = await resolveProject(data.project);

		const env = await getMiseEnv(p.dir);

		await tracedExeca("git", ["-C", p.dir, "fetch", p.upstreamRemote, p.upstreamBranch ?? "main"], {
			reject: false,
			env,
		});

		// Validate transition: rebase is allowed from needs_rebase state
		// Rebasing requires a clean working directory (all commits), unlike test/push which work on any commit
		if (p.dirty) {
			log.subprocess.debug(
				{project: data.project, branch: data.branch},
				"Warning: rebasing with dirty working directory",
			);
		}

		const checkout = await tracedExeca("git", ["-C", p.dir, "checkout", data.branch], {
			reject: false,
			env,
		});
		if (checkout.exitCode !== 0) {
			return {ok: false, message: `Failed to checkout ${data.branch}: ${checkout.stderr}`};
		}

		const branchSha = (
			await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false, env})
		).stdout.trim();
		const rebase = await tracedExeca("git", ["-C", p.dir, "rebase", p.upstreamRef], {
			reject: false,
			env,
		});
		if (rebase.exitCode !== 0) {
			await tracedExeca("git", ["-C", p.dir, "rebase", "--abort"], {reject: false, env});
			const upstreamSha = getCachedUpstreamSha(data.project);
			if (upstreamSha && branchSha) {
				cacheMergeStatus(data.project, branchSha, upstreamSha, 0, 1, false);
			}
			return {ok: false, message: `Rebase failed with conflicts: ${rebase.stderr}`};
		}

		const push = await tracedExeca(
			"git",
			["-C", p.dir, "push", p.remote, `${data.branch}:${data.branch}`, "--force-with-lease"],
			{reject: false, env},
		);
		if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
			return {ok: false, message: `Rebased but failed to push: ${push.stderr}`};
		}

		invalidatePrCache(data.project);
		invalidateMergeStatus(data.project);
		return {ok: true, message: `Rebased ${data.branch} onto ${p.upstreamRef}`};
	});
}

/**
 * Enqueues a single background rebase task for one branch, so the per-card
 * "Rebase" action runs on the shared task queue (visible on the Tasks page via
 * SSE) instead of blocking the click, consistent with "Rebase All".
 */
async function rebaseChildHandler(data: RebaseLocalInput): Promise<TestJobStatus> {
	return traced("rebaseChild", async () => {
		const {enqueueRebase} = await import("./task-queue.js");
		const p = await resolveProject(data.project);

		if (isDashboardRepo(p.dir)) {
			throw new Error(
				`Refusing to rebase a branch in ${p.name}: it is the repo the dashboard runs from, and checking out its branches would disrupt the server`,
			);
		}

		const logResult = await tracedExeca(
			"git",
			["-C", p.dir, "log", "-1", "--format=%H%x00%h%x00%s", `refs/heads/${data.branch}`],
			{reject: false},
		);
		const fields = logResult.stdout.split("\0");
		const sha = fields[0]?.trim() || "";
		const shortSha = fields[1]?.trim() || sha.slice(0, 7);
		const subject = fields[2]?.trim() || "";

		const task = enqueueRebase({
			project: p.name,
			projectDir: p.dir,
			sha,
			shortSha,
			subject,
			branch: data.branch,
			upstreamRemote: p.upstreamRemote,
			upstreamRef: p.upstreamRef,
			upstreamBranch: p.upstreamBranch ?? "main",
			remote: p.remote,
		});
		return {id: task.id, status: task.status, message: task.message};
	});
}

export const rebaseChild = createServerFn({method: "POST"})
	.validator((input: unknown) => RebaseLocalInputSchema.parse(input))
	.handler(async ({data}) => rebaseChildHandler(data));

/**
 * Returns true if `dir` is (or contains) the repo the dashboard server itself is
 * running from. Rebasing that repo would check out its branches and disrupt the
 * running server (and in dev, swap out the source it serves), so it is excluded
 * from bulk rebase.
 */
function isDashboardRepo(dir: string): boolean {
	const rel = path.relative(dir, process.cwd());
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Enqueues one background rebase task per branch that the UI classifies as
 * `needs_rebase` (the same set the "Rebase All (N)" button counts), across all
 * clean projects except the dashboard's own repo. This matches the displayed
 * count rather than rebasing every diverged local branch — abandoned/snoozed/
 * approved branches are excluded by classification. Tasks run serialized per
 * project on the shared task queue, so progress is visible on the Tasks page via
 * SSE instead of blocking the click.
 */
// Discover the branches that "Rebase All" would enqueue, without touching the task
// queue. Shared by the background enqueue and the count query.
async function planRebaseAll(readChildren: ChildrenReader): Promise<EnqueueRebaseOptions[]> {
	await ensureProjects();
	const projects = cachedProjects!;

	const planned: EnqueueRebaseOptions[] = [];

	for (const p of projects) {
		if (p.dirty || !p.hasTestConfigured) continue;
		if (isDashboardRepo(p.dir)) continue;

		const children = await readChildren(p);
		for (const child of children) {
			if (!child.branch) continue;
			if (classifyGitChild(child, p) !== "needs_rebase") continue;

			planned.push({
				project: p.name,
				projectDir: p.dir,
				sha: child.sha,
				shortSha: child.shortSha,
				subject: child.subject,
				branch: child.branch,
				upstreamRemote: p.upstreamRemote,
				upstreamRef: p.upstreamRef,
				upstreamBranch: p.upstreamBranch ?? "main",
				remote: p.remote,
			});
		}
	}

	return planned;
}

async function rebaseAllChildrenHandler(): Promise<TestJobStatus[]> {
	return traced("rebaseAllChildren", async () => {
		const {enqueueRebase} = await import("./task-queue.js");
		const planned = await planRebaseAll(readFreshChildren);
		return planned.map((opts) => {
			const task = enqueueRebase(opts);
			return {id: task.id, status: task.status, message: task.message};
		});
	});
}

export const rebaseAllChildren = createServerFn({method: "POST"}).handler(async () => {
	launchBackgroundEnqueue("rebaseAllChildren", rebaseAllChildrenHandler);
	return {started: true} as const;
});

export interface RunAllCounts {
	readyToTest: number;
	needsRebase: number;
}

// Read-only estimate of how much work the "Run All Tests" / "Rebase All" buttons will
// queue, so the tasks page can show the count before the click. Runs the same
// discovery as the enqueue paths but never mutates the queue.
async function runAllCountsHandler(): Promise<RunAllCounts> {
	return traced("runAllCounts", async () => {
		const [tests, rebases] = await Promise.all([
			planTestAll(readCachedChildren),
			planRebaseAll(readCachedChildren),
		]);
		return {readyToTest: tests.length, needsRebase: rebases.length};
	});
}

export const runAllCounts = createServerFn({method: "GET"}).handler(async () => runAllCountsHandler());

export type AdvancePlanAction = "rebase" | "test" | "resolve-conflicts" | "fix-failure";

export interface AdvancePlanBranchSummary {
	project: string;
	branch: string;
	tipSha: string;
	shortSha: string;
	ownedCommitCount: number;
	dependsOn: string[];
	worktreeRequired: boolean;
	expectedActions: AdvancePlanAction[];
}

export interface AdvancePlanProjectSummary {
	project: string;
	projectDir: string;
	upstreamRef: string;
	upstreamRemote: string;
	upstreamBranch: string;
	remote: string;
	status: "ready" | "skipped" | "noop";
	detail?: string;
	baselineNeedsTest: boolean;
	concurrency: number;
	branches: AdvancePlanBranchSummary[];
}

export interface AdvancePlanSummary {
	generatedAt: number;
	projects: AdvancePlanProjectSummary[];
}

export interface GenerateAdvancePlanInput {
	include?: string[];
	exclude?: string[];
}

const advanceProjectPlanActions: AdvancePlanAction[] = ["rebase", "test", "resolve-conflicts", "fix-failure"];

function skipReason(project: ProjectInfo): string | undefined {
	if (project.dirty) return "dirty";
	if (project.detachedHead) return "detached head";
	if (!project.hasTestConfigured) return "no test configured";
	return undefined;
}

export async function generateAdvancePlanForProjects(
	projects: ProjectInfo[],
	input: GenerateAdvancePlanInput = {},
): Promise<AdvancePlanSummary> {
	const include = input.include ?? [];
	const exclude = input.exclude ?? [];
	const projectSummaries: AdvancePlanProjectSummary[] = [];

	for (const project of projects) {
		if (!matchesFilters(project.name, include, exclude)) continue;

		const detail = skipReason(project);
		if (detail) {
			projectSummaries.push({
				project: project.name,
				projectDir: project.dir,
				upstreamRef: project.upstreamRef,
				upstreamRemote: project.upstreamRemote,
				upstreamBranch: project.upstreamBranch ?? "main",
				remote: project.remote,
				status: "skipped",
				detail,
				baselineNeedsTest: false,
				concurrency: resolveAdvanceConcurrency(project.name, project.dir),
				branches: [],
			});
			continue;
		}

		const plan = await planProject({project: project.name, dir: project.dir, upstreamRef: project.upstreamRef});
		const status = plan.units.length === 0 && !plan.baseline.needsTest ? "noop" : "ready";

		projectSummaries.push({
			project: project.name,
			projectDir: project.dir,
			upstreamRef: project.upstreamRef,
			upstreamRemote: project.upstreamRemote,
			upstreamBranch: project.upstreamBranch ?? "main",
			remote: project.remote,
			status,
			baselineNeedsTest: plan.baseline.needsTest,
			concurrency: resolveAdvanceConcurrency(project.name, project.dir),
			branches: plan.units.map((unit) => ({
				project: unit.project,
				branch: unit.branch,
				tipSha: unit.tipSha,
				shortSha: unit.tipSha.slice(0, 7),
				ownedCommitCount: unit.chain.length,
				dependsOn: unit.dependsOn,
				worktreeRequired: unit.worktreeRequired,
				expectedActions: advanceProjectPlanActions,
			})),
		});
	}

	return {generatedAt: Date.now(), projects: projectSummaries};
}

async function generateAdvancePlanHandler(input: GenerateAdvancePlanInput = {}): Promise<AdvancePlanSummary> {
	return traced("generateAdvancePlan", async () => {
		await ensureProjects();
		return generateAdvancePlanForProjects(cachedProjects!, input);
	});
}

export const generateAdvancePlan = createServerFn({method: "POST"})
	.validator((input: unknown) =>
		z
			.object({
				include: z.array(z.string()).optional(),
				exclude: z.array(z.string()).optional(),
			})
			.parse(input ?? {}),
	)
	.handler(async ({data}) => generateAdvancePlanHandler(data));

async function refreshAllHandler(): Promise<ActionResult> {
	return tracedAction("refreshAll", async () => {
		cachedProjects = null;
		cachedProjectsTime = 0;
		invalidateIssuesCache();
		invalidateProjectItemsCache();
		// Re-populate the project cache and invalidate PR caches
		const projects = await refreshProjectCache();
		for (const p of projects) {
			invalidatePrCache(p.name);
			invalidateChildrenCache(p.name);
			invalidateTodosCache(p.name);
		}
		return {ok: true, message: "All caches invalidated"};
	});
}

export const refreshAll = createServerFn({method: "POST"}).handler(async () => refreshAllHandler());

export interface SystemStatus {
	/** Epoch ms until which GitHub API calls are suppressed, or null when healthy. */
	rateLimitedUntil: number | null;
	/** Per-project children cache last-refreshed timestamps (DB format, UTC). */
	childrenRefreshedAt: Record<string, string>;
}

async function getSystemStatusHandler(): Promise<SystemStatus> {
	return traced("getSystemStatus", async () => {
		const rateLimit = getGitHubRateLimitState();
		return {
			rateLimitedUntil: rateLimit.until,
			childrenRefreshedAt: Object.fromEntries(getCacheFreshnessByPrefix("children:")),
		};
	});
}

export const getSystemStatus = createServerFn({method: "GET"}).handler(async () => getSystemStatusHandler());
