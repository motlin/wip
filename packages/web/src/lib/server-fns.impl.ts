import {
	applyFixesToBranch,
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
	getCommitFacts,
	getSplitThresholdLines,
	getTestLogDir,
	invalidatePrCache,
	invalidateIssuesCache,
	invalidateProjectItemsCache,
	backfillSnoozedPatchIds,
	resolveSnoozedChildren,
	snoozeItem,
	suggestBranchNames,
	unsnoozeItem,
	getCachedUpstreamSha,
	getCachedMergeStatuses,
	invalidateMergeStatus,
	rebaseBranchOntoUpstream,
	getNeedsRebaseBranches,
	getCachedProjectList,
	setCachedProjectList,
	getCachedChildren,
	cacheChildren,
	reconcileWorkItemsWithUpstream,
	invalidateChildrenCache,
	isCacheFresh,
	getCacheFreshnessByPrefix,
	getGitHubRateLimitState,
	getCachedTodos,
	cacheTodos,
	getCachedIssues,
	getCachedProjectItems,
	getDb,
	type LadderResult,
	type ProjectInfo,
	type RunLadderOptions,
	type GitChildResult,
	type TodoItem as SharedTodoItem,
	type IssueResult,
	type ProjectItemResult,
	type GitHubProjectItem,
	type BaseBranchStatus,
	type ActionResult,
	type SnoozedChild,
	type PushChildInput,
	type TestChildInput,
	type SnoozeChildInput,
	type UnsnoozeChildInput,
	type CreatePrInput,
	type CreateBranchInput,
	type DeleteBranchInput,
	type ForcePushInput,
	type RenameBranchInput,
	type ApplyFixesInput,
	type MergePrInput,
	type RebaseLocalInput,
	TaskQueueJobSchema,
	type TaskQueueJob,
	planProject,
	resolveAdvanceConcurrency,
	getGitTestStatuses,
	matchesFilters,
	buildInventoryFromTemplates,
	getInventoryPath,
	inventoryExists,
	loadInventory,
	selectTrackedProjects,
	readTemplateTexts,
	saveInventory,
	summarizeRegistry,
	buildRegistryCandidates,
	type InventoryStatus,
	type RegistryCandidates,
	type SaveRegistryInput,
	classifyGitChild,
} from "@wip/shared";
import {considerSplitting} from "@wip/shared/candidate-rank.js";
import {log} from "@wip/shared/services/logger-pino.js";
import {enqueueRefresh, refreshFailureSince, refreshOutcomeMark, trackRefreshOutcome} from "./refresh-scheduler.js";
import {captureActionLogs, runQueuedAction} from "./queued-action.js";
import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";
import {parseDiffFiles, type FileDiff} from "./diff-parser.js";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {getTracer} from "@wip/shared/services/telemetry.js";
import type {EnqueueRebaseOptions, LadderAiOptions} from "./task-queue.js";
import {focusHerdrPane} from "./herdr/focus.js";
import type {HerdrResult} from "./herdr/client.js";
import * as fs from "node:fs";
import * as os from "node:os";
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
	const {result, logs} = await captureActionLogs(async () => traced(name, fn));
	if (logs.length === 0) return result;
	return {
		...result,
		logs: logs.map((e) => ({time: e.time, level: e.level, category: e.category, msg: e.msg})),
	};
}

export type {ActionResult, SnoozedChild, GitChildResult};

export type ProjectChildrenResult = GitChildResult[];

/** A red local baseline: `git test results` says the upstream tip fails the default git-test. */
export function localBaselineRedChild(
	p: ProjectInfo,
	upstreamSha: string,
	upstreamTestStatus: "passed" | "failed" | undefined,
	date: string,
): GitChildResult | undefined {
	if (upstreamTestStatus !== "failed") return undefined;
	return {
		kind: "upstream_ci",
		project: p.name,
		remote: p.remote,
		originRemote: p.originRemote,
		sha: upstreamSha,
		shortSha: upstreamSha.slice(0, 7),
		subject: `Fix failing tests on ${p.upstreamRef}`,
		date,
		branch: p.upstreamBranch,
		testStatus: "failed",
		checkStatus: "none",
		skippable: false,
		pushedToRemote: true,
		reviewStatus: "no_pr",
	};
}

async function readLocalBaselineRedChild(p: ProjectInfo, upstreamSha: string): Promise<GitChildResult | undefined> {
	try {
		const status = (await getGitTestStatuses(p.dir, [upstreamSha])).get(upstreamSha);
		if (status !== "failed") return undefined;
		const {stdout} = await tracedExeca("git", ["-C", p.dir, "show", "-s", "--format=%cs", upstreamSha], {
			reject: false,
		});
		return localBaselineRedChild(p, upstreamSha, status, stdout.trim());
	} catch (error: unknown) {
		log.general.warn({project: p.name, error}, "Reading the baseline git-test result failed");
		return undefined;
	}
}

export function getManagedFailedBaseBranches(baseBranches: BaseBranchStatus[]): BaseBranchStatus[] {
	return baseBranches.filter((base) => base.policy === "managed" && base.checkStatus === "failed");
}

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

async function ensureProjects(): Promise<ProjectInfo[]> {
	if (cachedProjects && Date.now() - cachedProjectsTime <= PROJECT_CACHE_TTL) return cachedProjects;
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
		return fromDb;
	}
	return refreshProjectCache();
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

async function resolveProject(project: string): Promise<ProjectInfo> {
	const projects = await ensureProjects();
	const p = projects.find((proj) => proj.name === project);
	if (!p) throw new Error(`Project not found: ${project}`);
	return p;
}

export async function getProjectsHandler(): Promise<ProjectInfo[]> {
	return traced("getProjects", async () => {
		return ensureProjects();
	});
}

const inflightChildrenRefresh = new Map<string, Promise<ProjectChildrenResult>>();

export async function refreshProjectChildren(projectName: string): Promise<ProjectChildrenResult> {
	const existing = inflightChildrenRefresh.get(projectName);
	if (existing) return existing;

	const {suppressWatcherEvents} = await import("./watch-suppression.js");
	const promise = suppressWatcherEvents(projectName, async () =>
		traced("refreshProjectChildren", async () => {
			let p: ProjectInfo;
			try {
				p = await resolveProject(projectName);
			} catch (error: unknown) {
				log.general.error({project: projectName, error}, "Project resolution failed");
				return [];
			}

			const prStatuses = await getPrStatuses(p.dir, p.name, p.upstreamRemote, p.upstreamBranch);

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
				getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, mergeStatusMap),
				getRemoteBranchInfo(p.dir),
			]);

			// Discover branches that need rebase (upstream is not an ancestor)
			const needsRebaseBranches = await getNeedsRebaseBranches(
				p.dir,
				p.upstreamRef,
				prStatuses,
				remoteBranchInfo.remoteBranches,
				remoteBranchInfo.remoteBranchRefs,
				mergeStatusMap,
			);

			clearExpiredSnoozes();
			const seen = new Set<string>();
			const uniqueChildren = [...children, ...needsRebaseBranches].filter((c) => {
				if (seen.has(c.sha)) return false;
				seen.add(c.sha);
				return true;
			});
			// Size (and patch-id) for every child in one batch through the commit_facts cache, before
			// resolveSnoozedChildren so its patch-id lookup reads the cache instead of spawning again.
			const commitFacts = await getCommitFacts(
				p.dir,
				p.name,
				uniqueChildren.map((c) => c.sha),
			);
			const splitThresholdLines = getSplitThresholdLines();
			// On hold and snoozed children are returned flagged, not dropped, and get no background jobs.
			const snoozes = await resolveSnoozedChildren(p.dir, p.name, uniqueChildren);

			// Collect all children that need branch name suggestions and fetch cached names up front
			const defaultBranchPattern = /^(main|master)$/;
			const namingKeys = uniqueChildren
				.filter((c) => !snoozes.held.has(c.sha))
				.filter((c) => !c.branch || defaultBranchPattern.test(c.branch))
				.map((c) => ({sha: c.sha, project: p.name, subject: c.subject, dir: p.dir}));
			const cachedNames = namingKeys.length > 0 ? getBranchNames(namingKeys) : new Map<string, string>();

			const uncachedKeys = namingKeys.filter((k) => !cachedNames.has(`${k.project}:${k.sha}`));
			for (const request of uncachedKeys) {
				workQueue.enqueue({
					coalesceKey: `branch-name:${request.project}:${request.sha}`,
					laneKey: "branch-name",
					kind: "branch-name",
					project: request.project,
					costClass: "ai",
					run: async () => {
						await suggestBranchNames([request]);
					},
				});
			}

			const headSha = (
				await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false})
			).stdout.trim();

			const results: GitChildResult[] = uniqueChildren.map((child) => {
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
				const facts = commitFacts.get(child.sha);
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
					externalCiBlockers: child.externalCiBlockers,
					commitsBehind: ms?.commitsBehind ?? child.commitsBehind,
					commitsAhead: ms?.commitsAhead ?? child.commitsAhead,
					rebaseable: ms?.rebaseable ?? child.rebaseable,
					mergeStateStatus: child.mergeStateStatus,
					alreadyOnRemote: child.alreadyOnRemote,
					containingBranch: child.containingBranch,
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
					isHead: child.sha === headSha,
					patchId: snoozes.patchIds.get(child.sha),
					onHold: snoozes.held.has(child.sha) || undefined,
					files: facts?.files,
					insertions: facts?.insertions,
					deletions: facts?.deletions,
					considerSplitting: facts && considerSplitting(facts, splitThresholdLines) ? true : undefined,
				};
			});
			const failedBases = getManagedFailedBaseBranches(prStatuses.baseBranches);
			const firstFailedBase = failedBases[0];
			if (firstFailedBase) {
				const failedChecks = failedBases
					.flatMap((base) => base.failedChecks)
					.filter(
						(check, index, checks) =>
							checks.findIndex((candidate) => candidate.name === check.name) === index,
					);
				results.push({
					kind: "upstream_ci",
					project: p.name,
					remote: failedBases.map((base) => base.repository).join(", "),
					originRemote: p.originRemote,
					sha: firstFailedBase.sha,
					shortSha: firstFailedBase.sha.slice(0, 7),
					subject: `Fix failing CI on ${failedBases.map((base) => `${base.remote}/${base.branch}`).join(" and ")}`,
					date: firstFailedBase.date,
					branch: firstFailedBase.branch,
					testStatus: "unknown",
					checkStatus: "failed",
					skippable: false,
					pushedToRemote: true,
					reviewStatus: "no_pr",
					prUrl: `${firstFailedBase.repositoryUrl}/actions`,
					failedChecks,
				});
			} else if (p.hasTestConfigured && upstreamSha) {
				const baselineRed = await readLocalBaselineRedChild(p, upstreamSha);
				if (baselineRed) results.push(baselineRed);
			}

			// The work-item ledger follows each change by patch-id; a departure is landed when
			// upstream contains it (or landing detection names it), otherwise abandoned.
			await reconcileWorkItemsWithUpstream(
				p.dir,
				p.name,
				p.upstreamRef,
				results.flatMap((child) => {
					const patchId = commitFacts.get(child.sha)?.patchId;
					if (child.kind === "upstream_ci" || !patchId) return [];
					return [{patchId, sha: child.sha, subject: child.subject, state: classifyGitChild(child, p)}];
				}),
			);
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
			if (!isCacheFresh(`children:${project}`, CHILDREN_CACHE_TTL_MS)) enqueueChildrenRefresh(project);
			return cached;
		}
		return refreshChildrenThroughQueue(project);
	});
}

function enqueueChildrenRefresh(project: string): void {
	enqueueRefresh({
		kind: "children",
		project,
		run: async () => {
			await refreshProjectChildren(project);
		},
	});
}

/**
 * Cold-cache read: run the refresh as a foreground job on the shared queue so it
 * draws from the global concurrency budget, then await its settlement. A
 * coalesced request reads the result the in-flight job already cached.
 */
async function refreshChildrenThroughQueue(project: string): Promise<ProjectChildrenResult> {
	let result: ProjectChildrenResult | undefined;
	const key = `children:${project}`;
	const mark = refreshOutcomeMark();
	const handle = workQueue.enqueue({
		coalesceKey: key,
		resources: [repoResource(project)],
		kind: "children",
		project,
		costClass: "cheap",
		priority: "foreground",
		run: trackRefreshOutcome(key, async () => {
			result = await refreshProjectChildren(project);
		}),
	});
	await handle.settled;
	// A coalesced caller never runs its own job (it may be a background refresh), so it
	// reads the outcome the shared job recorded: failures and cancellations throw.
	const failure = refreshFailureSince(key, mark);
	if (failure) throw failure.error;
	return result ?? getCachedChildren(project) ?? [];
}

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
			blocked: task.blocked,
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

export async function getProjectTodosHandler(project: string): Promise<SharedTodoItem[]> {
	return traced("getProjectTodos", async () => {
		const cached = getCachedTodos(project);
		if (cached) {
			if (!isCacheFresh(`todos:${project}`, TODOS_CACHE_TTL_MS)) enqueueTodosRefresh(project);
			return cached;
		}
		return refreshProjectTodos(project);
	});
}

function enqueueTodosRefresh(project: string): void {
	enqueueRefresh({
		kind: "todos",
		project,
		run: async () => {
			await refreshProjectTodos(project);
		},
	});
}

export const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Serve a GitHub-backed list from the DB cache and refresh it in the background
 * through the shared WorkQueue, pushing the result over SSE. Only a cache that
 * was never filled waits on GitHub.
 */
async function serveGitHubCache<T>(options: {
	kind: "issues" | "project-items";
	freshnessKey: string;
	event: "issues" | "projectItems";
	readCache: () => T[] | null;
	fetch: () => Promise<T[]>;
}): Promise<T[]> {
	// An empty list stores no rows, so a freshness row alone marks it as cached.
	const everRefreshed = getCacheFreshnessByPrefix(options.freshnessKey).has("");
	const cached = options.readCache() ?? (everRefreshed ? [] : null);
	if (cached === null) return options.fetch();
	if (!isCacheFresh(options.freshnessKey, GITHUB_CACHE_TTL_MS)) {
		enqueueRefresh({
			kind: options.kind,
			project: "github",
			run: async () => {
				const fresh = await options.fetch();
				const {githubEmitter} = await import("./github-events.js");
				githubEmitter.emit(options.event, fresh);
			},
		});
	}
	return cached;
}

export async function getIssuesHandler(): Promise<IssueResult[]> {
	return traced("getIssues", async () =>
		serveGitHubCache({
			kind: "issues",
			freshnessKey: "github-issues",
			event: "issues",
			readCache: getCachedIssues,
			fetch: fetchAssignedIssues,
		}),
	);
}

export async function getProjectItemsHandler(): Promise<GitHubProjectItem[]> {
	return traced("getProjectItemsFn", async () =>
		serveGitHubCache({
			kind: "project-items",
			freshnessKey: "github-project-items",
			event: "projectItems",
			readCache: getCachedProjectItems,
			fetch: fetchAllProjectItems,
		}),
	);
}

export interface QueueSnapshot {
	/** Keyed by project; a project whose cold refresh failed is absent. */
	children: Record<string, ProjectChildrenResult>;
	todos: Record<string, SharedTodoItem[]>;
	/** Null when the GitHub list could not be served, so the client falls back to its own query. */
	issues: IssueResult[] | null;
	projectItems: GitHubProjectItem[] | null;
	snoozed: SnoozedChild[];
}

/**
 * Everything the queue views read, in one request: every project's children and
 * todos come from a single read transaction instead of one request per project.
 * Stale entries are served and refreshed in the background; only a project with
 * no cache row waits on its cold refresh.
 */
export async function getQueueSnapshotHandler(): Promise<QueueSnapshot> {
	return traced("getQueueSnapshot", async () => {
		const projects = await ensureProjects();
		clearExpiredSnoozes();
		const read = getDb().transaction(() => ({
			entries: projects.map((p) => ({
				project: p.name,
				children: getCachedChildren(p.name),
				childrenFresh: isCacheFresh(`children:${p.name}`, CHILDREN_CACHE_TTL_MS),
				todos: getCachedTodos(p.name),
				todosFresh: isCacheFresh(`todos:${p.name}`, TODOS_CACHE_TTL_MS),
			})),
			snoozed: getAllSnoozedForDisplay(),
		}));

		const [entries, issues, projectItems] = await Promise.all([
			Promise.all(
				read.entries.map(async (entry) => {
					if (entry.children && !entry.childrenFresh) enqueueChildrenRefresh(entry.project);
					if (entry.todos && !entry.todosFresh) enqueueTodosRefresh(entry.project);
					const [children, todos] = await Promise.all([
						entry.children ?? refreshChildrenThroughQueue(entry.project).catch(() => undefined),
						entry.todos ?? refreshProjectTodos(entry.project),
					]);
					return {project: entry.project, children, todos};
				}),
			),
			getIssuesHandler().catch(() => null),
			getProjectItemsHandler().catch(() => null),
		]);

		return {
			// A failed cold refresh leaves the project out, so its own query surfaces the error.
			children: Object.fromEntries(
				entries.flatMap((e) => (e.children === undefined ? [] : [[e.project, e.children] as const])),
			),
			todos: Object.fromEntries(entries.map((e) => [e.project, e.todos])),
			issues,
			projectItems,
			snoozed: read.snoozed,
		};
	});
}

export async function getIssueByNumberHandler(data: {project: string; number: number}): Promise<IssueResult | null> {
	return traced("getIssueByNumber", async () => {
		const issues = await fetchAssignedIssues();
		const p = cachedProjects?.find((proj) => proj.name === data.project);
		for (const issue of issues) {
			if (issue.number !== data.number) continue;
			const repoKey = issue.repository.nameWithOwner.toLowerCase();
			if (p?.remote.toLowerCase() === repoKey || issue.repository.name === data.project) {
				return issue;
			}
		}
		return null;
	});
}

export async function getProjectItemByNumberHandler(data: {
	project: string;
	number: number;
}): Promise<ProjectItemResult | null> {
	return traced("getProjectItemByNumber", async () => {
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
					status: item.status,
					type: item.type,
					labels: item.labels,
				};
			}
		}
		return null;
	});
}

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

export async function createPrHandler(data: CreatePrInput): Promise<ActionResult> {
	return tracedAction("createPr", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "createPr", async () => {
			const env = await getMiseEnv(p.dir);

			const fetch = await tracedExeca("git", ["-C", p.dir, "fetch", p.upstreamRemote, p.upstreamBranch], {
				reject: false,
				env,
			});
			if (fetch.exitCode !== 0) {
				return {ok: false, message: `Failed to fetch ${p.upstreamRef}: ${fetch.stderr}`};
			}

			const branch = await tracedExeca("git", ["-C", p.dir, "rev-parse", "--verify", `${data.branch}^{commit}`], {
				reject: false,
				env,
			});
			if (branch.exitCode !== 0) {
				return {ok: false, message: `Could not resolve branch ${data.branch}: ${branch.stderr}`};
			}

			const upstream = await tracedExeca(
				"git",
				["-C", p.dir, "rev-parse", "--verify", `${p.upstreamRef}^{commit}`],
				{
					reject: false,
					env,
				},
			);
			if (upstream.exitCode !== 0) {
				return {ok: false, message: `Could not resolve upstream ${p.upstreamRef}: ${upstream.stderr}`};
			}

			const containsUpstream = await tracedExeca(
				"git",
				["-C", p.dir, "merge-base", "--is-ancestor", p.upstreamRef, data.branch],
				{reject: false, env},
			);
			if (containsUpstream.exitCode !== 0) {
				return {ok: false, message: `${data.branch} is behind ${p.upstreamRef}; rebase before creating a PR`};
			}

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
		});
	});
}

export interface TestJobStatus {
	id: string;
	status: "queued" | "running" | "passed" | "failed" | "cancelled";
	message?: string;
}

export async function testChildHandler(data: TestChildInput): Promise<TestJobStatus> {
	return traced("testChild", async () => {
		const p = await resolveProject(data.project);

		const logResult = await tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%h%x00%s%x00%D", data.sha], {
			reject: false,
		});
		const parts = logResult.stdout.split("\0");
		const shortSha = nonEmpty(parts[0]?.trim()) ?? data.sha.slice(0, 7);
		const subject = parts[1]?.trim() ?? "";
		const decoration = parts[2]?.trim() ?? "";
		const branchMatch = decoration.match(/(?:^|,\s*)(?:HEAD -> )?([^,\s][^,]*?)(?:\s*,|$)/);
		const branch = nonEmpty(branchMatch?.[1]?.replace(/^refs\/heads\//, ""));

		// Reject invalid transitions loudly — the card renders the thrown
		// message, instead of enqueueing a test that cannot run.
		// Only check dirty state if operating on HEAD.
		const headSha = (await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false})).stdout.trim();
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

		// An explicit Run Test on a test_failed commit re-runs it; otherwise git-test's cached result stands.
		const retest = (await getGitTestStatuses(p.dir, [data.sha])).get(data.sha) === "failed";
		const {enqueueTest} = await import("./task-queue.js");
		const job = enqueueTest(data.project, p.dir, data.sha, shortSha, subject, branch, {retest});
		return {id: job.id, status: job.status, message: job.message};
	});
}

const backgroundEnqueues = new Set<Promise<unknown>>();

// Run a heavy discover-and-enqueue routine in the background so the POST returns
// immediately. Tasks stream to the client via the task-queue SSE feed as they are
// enqueued, instead of the click blocking until every project has been scanned.
export function launchBackgroundEnqueue(name: string, run: () => Promise<unknown>): void {
	const promise = run()
		.catch((err: unknown) => {
			log.general.error({err}, `${name} background enqueue failed`);
			workQueue.reportJobError({
				kind: name,
				project: "all projects",
				message: err instanceof Error ? err.message : String(err),
			});
		})
		.finally(() => {
			backgroundEnqueues.delete(promise);
		});
	backgroundEnqueues.add(promise);
}

/** Test-only: wait until every launchBackgroundEnqueue routine, including ones launched meanwhile, has settled. */
export async function drainBackgroundEnqueues(): Promise<void> {
	while (backgroundEnqueues.size > 0) {
		// Sequential on purpose: a draining routine can launch another, so re-check after each wait
		// eslint-disable-next-line no-await-in-loop
		await Promise.allSettled(backgroundEnqueues);
	}
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

const readCachedChildren: ChildrenReader = async (p) => Promise.resolve(getCachedChildren(p.name) ?? []);
const readFreshChildren: ChildrenReader = async (p) => getProjectChildrenHandler(p.name);

// Discover the untested child commits that "Run All Tests" would enqueue, without
// touching the task queue. Uses the same classification as the queue UI so the
// button's (N) always matches what a click actually queues.
async function planTestAll(readChildren: ChildrenReader): Promise<PlannedTest[]> {
	const projects = await ensureProjects();

	const planned: PlannedTest[] = [];
	for (const p of projects) {
		if (!p.hasTestConfigured) continue;

		// Sequential on purpose: readChildren may spawn git/API work, so fan-out must stay bounded
		// eslint-disable-next-line no-await-in-loop
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

export function launchTestAllChildren(): void {
	launchBackgroundEnqueue("testAllChildren", testAllChildrenHandler);
}

export type {FileDiff} from "./diff-parser.js";

export async function getCommitDiffHandler(data: {
	project: string;
	sha: string;
}): Promise<{files: FileDiff[]; stat: string; subject: string}> {
	return traced("getCommitDiff", async () => {
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

		// Fetch file content with stripFinalNewline: false so it matches the diff hunks exactly.
		const showFile = async (ref: string): Promise<string> => {
			const result = await tracedExeca("git", ["-C", p.dir, "show", ref], {
				reject: false,
				stripFinalNewline: false,
			});
			return result.exitCode === 0 ? result.stdout : "";
		};
		const files = await parseDiffFiles(diffResult.stdout, {
			old: async (fileName) => showFile(`${data.sha}^:${fileName}`),
			new: async (fileName) => showFile(`${data.sha}:${fileName}`),
		});

		return {
			files,
			stat: statResult.exitCode === 0 ? statResult.stdout : "",
			subject: subjectResult.exitCode === 0 ? subjectResult.stdout.trim() : "",
		};
	});
}

export async function getWorkingTreeDiffHandler(project: string): Promise<{files: FileDiff[]; stat: string}> {
	return traced("getWorkingTreeDiff", async () => {
		const p = await resolveProject(project);

		// Show all uncommitted changes (staged + unstaged) relative to HEAD
		const [diffResult, statResult] = await Promise.all([
			tracedExeca("git", ["-C", p.dir, "diff", "HEAD"], {reject: false}),
			tracedExeca("git", ["-C", p.dir, "diff", "HEAD", "--stat"], {reject: false}),
		]);

		if (diffResult.exitCode !== 0) {
			return {files: [], stat: ""};
		}

		const showFile = async (ref: string): Promise<string> => {
			const result = await tracedExeca("git", ["-C", p.dir, "show", ref], {
				reject: false,
				stripFinalNewline: false,
			});
			return result.exitCode === 0 ? result.stdout : "";
		};
		const files = await parseDiffFiles(diffResult.stdout, {
			old: async (fileName) => showFile(`HEAD:${fileName}`),
			// Prefer the index copy (staged content); fall back to HEAD for unstaged-only files.
			new: async (fileName) => {
				const staged = await tracedExeca("git", ["-C", p.dir, "cat-file", "-p", `:${fileName}`], {
					reject: false,
					stripFinalNewline: false,
				});
				if (staged.exitCode === 0) return staged.stdout;
				return showFile(`HEAD:${fileName}`);
			},
		});

		return {
			files,
			stat: statResult.exitCode === 0 ? statResult.stdout : "",
		};
	});
}

export async function commitWorkingTreeHandler(project: string): Promise<ActionResult> {
	return tracedAction("commitWorkingTree", async () => {
		const p = await resolveProject(project);

		return runQueuedAction(
			project,
			"commitWorkingTree",
			async () => {
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
			},
			"ai",
		);
	});
}

export async function getTestLogHandler(data: {
	project: string;
	sha: string;
}): Promise<{log: string | null; tail: string | null}> {
	return traced("getTestLog", async () => {
		const logDir = getTestLogDir(data.project);
		const logPath = path.join(logDir, `${data.sha}.log`);
		if (!fs.existsSync(logPath)) {
			return Promise.resolve({log: null, tail: null});
		}
		const content = fs.readFileSync(logPath, "utf-8");
		const lines = content.trimEnd().split("\n");
		const tail = lines.slice(-20).join("\n");
		return Promise.resolve({log: content, tail});
	});
}

export async function snoozeChildHandler(data: SnoozeChildInput): Promise<ActionResult> {
	return tracedAction("snoozeChildFn", async () => {
		const p = await resolveProject(data.project);

		const logResult = await tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%h%x00%s", data.sha], {
			reject: false,
		});
		const snoozeFields = logResult.exitCode === 0 ? logResult.stdout.split("\0") : [data.sha.slice(0, 7), ""];
		const shortSha = snoozeFields[0] ?? data.sha.slice(0, 7);
		const subject = snoozeFields[1] ?? "";

		// Patch-id keys the row so the item stays On hold / snoozed across a rebase.
		const facts = await getCommitFacts(p.dir, data.project, [data.sha]);
		const patchId = facts.get(data.sha)?.patchId ?? null;

		log.subprocess.debug({project: data.project, sha: data.sha, patchId}, "Snoozing work item");

		snoozeItem(data.sha, data.project, shortSha, subject, data.until, patchId);
		// On hold frees the item's ready slot; one pull refills it.
		const {readyBufferEmitter} = await import("./ready-buffer-events.js");
		readyBufferEmitter.emit("onHold", {project: data.project});
		return {ok: true, message: data.until ? `Snoozed until ${data.until}` : "On hold"};
	});
}

export async function unsnoozeChildHandler(data: UnsnoozeChildInput): Promise<ActionResult> {
	return tracedAction("unsnoozeChildFn", async () => {
		unsnoozeItem(data.sha, data.project);
		return Promise.resolve({ok: true, message: "Unsnoozed"});
	});
}

export async function getSnoozedListHandler(): Promise<SnoozedChild[]> {
	return traced("getSnoozedList", async () => {
		clearExpiredSnoozes();
		// Fill patch-ids for pre-migration rows so orphaned ones show as orphaned here.
		const projects = await ensureProjects();
		const projectsWithRows = new Set(getAllSnoozedForDisplay().map((row) => row.project));
		await Promise.all(
			projects
				.filter((p) => projectsWithRows.has(p.name))
				.map(async (p) => backfillSnoozedPatchIds(p.dir, p.name)),
		);
		return getAllSnoozedForDisplay();
	});
}

export async function getTaskQueueHandler(): Promise<TaskQueueJob[]> {
	return traced("getTaskQueue", async () => {
		const {getAllTasks} = await import("./task-queue.js");
		const tasks = getAllTasks();
		return Array.from(tasks.values()).map((t) => TaskQueueJobSchema.parse(t));
	});
}

export async function cancelTestHandler(id: string): Promise<ActionResult> {
	return tracedAction("cancelTestFn", async () => {
		const {cancelTest} = await import("./task-queue.js");
		const result = cancelTest(id);
		return {ok: result.ok, message: result.message};
	});
}

export async function runClaudeCommandHandler(data: {
	project: string;
	sha: string;
	branch?: string;
	command: string;
}): Promise<TestJobStatus> {
	return traced("runClaudeCommand", async () => {
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
	});
}

export async function refreshChildHandler(project: string): Promise<ActionResult> {
	return tracedAction("refreshChild", async () => {
		invalidatePrCache(project);
		invalidateChildrenCache(project);
		await refreshProjectChildren(project);
		return {ok: true, message: `Refreshed ${project}`};
	});
}

export async function createBranchHandler(data: CreateBranchInput): Promise<ActionResult> {
	return tracedAction("createBranch", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "createBranch", async () => {
			const result = await tracedExeca("git", ["-C", p.dir, "checkout", "-b", data.branchName, data.sha], {
				reject: false,
			});

			if (result.exitCode === 0) {
				return {ok: true, message: `Created branch ${data.branchName}`};
			}

			return {ok: false, message: `Failed to create branch: ${result.stderr}`};
		});
	});
}

export async function deleteBranchHandler(data: DeleteBranchInput): Promise<ActionResult> {
	return tracedAction("deleteBranch", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "deleteBranch", async () => {
			const result = await tracedExeca("git", ["-C", p.dir, "branch", "-D", data.branch], {
				reject: false,
			});

			if (result.exitCode === 0) {
				invalidatePrCache(data.project);
				invalidateChildrenCache(data.project);
				return {ok: true, message: `Deleted branch ${data.branch}`};
			}

			return {ok: false, message: `Failed to delete branch: ${result.stderr}`};
		});
	});
}

export async function forcePushHandler(data: ForcePushInput): Promise<ActionResult> {
	return tracedAction("forcePush", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "forcePush", async () => {
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
		});
	});
}

export async function mergePrHandler(data: MergePrInput): Promise<ActionResult> {
	return tracedAction("mergePr", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "mergePr", async () => {
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
		});
	});
}

export async function renameBranchHandler(data: RenameBranchInput): Promise<ActionResult> {
	return tracedAction("renameBranch", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "renameBranch", async () => {
			const result = await tracedExeca("git", ["-C", p.dir, "branch", "-m", data.oldBranch, data.newBranch], {
				reject: false,
			});

			if (result.exitCode === 0) {
				invalidatePrCache(data.project);
				invalidateChildrenCache(data.project);
				return {ok: true, message: `Renamed ${data.oldBranch} → ${data.newBranch}`};
			}

			return {ok: false, message: `Failed to rename branch: ${result.stderr}`};
		});
	});
}

export async function applyFixesHandler(data: ApplyFixesInput): Promise<ActionResult> {
	return tracedAction("applyFixes", async () => {
		const p = await resolveProject(data.project);

		return runQueuedAction(data.project, "applyFixes", async () => {
			const env = await getMiseEnv(p.dir);

			const result = await applyFixesToBranch(p.dir, {branch: data.branch, prNumber: data.prNumber, env});
			if (result.ok) {
				invalidatePrCache(data.project);
				invalidateChildrenCache(data.project);
			}
			return result;
		});
	});
}

export async function rebaseLocalHandler(data: RebaseLocalInput): Promise<ActionResult> {
	return tracedAction("rebaseLocal", async () => {
		const p = await resolveProject(data.project);

		return runQueuedAction(data.project, "rebaseLocal", async () => {
			const env = await getMiseEnv(p.dir);

			// Validate transition: rebase is allowed from needs_rebase state
			// Rebasing requires a clean working directory (all commits), unlike test/push which work on any commit
			if (p.dirty) {
				log.subprocess.debug(
					{project: data.project, branch: data.branch},
					"Warning: rebasing with dirty working directory",
				);
			}

			// No explicit pushRemote: this handler used to push to p.remote, but that is
			// the GitHub "owner/repo" slug, not a git remote name, so the push silently
			// failed. Let the operation resolve the branch's configured git remote
			// (falling back to "origin"), same as the task queue's rebase.
			const result = await rebaseBranchOntoUpstream(p.dir, {
				branch: data.branch,
				project: data.project,
				upstreamRef: p.upstreamRef,
				upstreamRemote: p.upstreamRemote,
				fetchBranch: p.upstreamBranch,
				env,
			});
			if (!result.ok) {
				if (result.stage === "checkout") {
					return {ok: false, message: `Failed to checkout ${data.branch}: ${result.stderr}`};
				}
				if (result.stage === "rebase") {
					return {ok: false, message: `Rebase failed with conflicts: ${result.stderr}`};
				}
				return {ok: false, message: `Rebased but failed to push: ${result.stderr}`};
			}

			invalidatePrCache(data.project);
			invalidateMergeStatus(data.project);
			return {ok: true, message: result.message};
		});
	});
}

type InterruptedOperation = "rebase" | "cherry-pick" | "merge";

/** Clear a project's rebaseInProgress flag in the project cache and tell clients, without a full rediscovery. */
async function markRebaseFinished(project: string): Promise<void> {
	const projects = cachedProjects;
	const entry = projects?.find((p) => p.name === project);
	if (!projects || !entry) return;
	entry.rebaseInProgress = false;
	setCachedProjectList(projects);
	const {projectEmitter} = await import("./project-events.js");
	projectEmitter.emit("projects", projects);
}

/** The branch a stopped rebase is replaying, from its head-name file; undefined when it is rebasing a detached HEAD. */
function rebasingBranch(rebaseDir: string): string | undefined {
	const headName = path.join(rebaseDir, "head-name");
	if (!fs.existsSync(headName)) return undefined;
	const ref = fs.readFileSync(headName, "utf8").trim();
	return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

/** The rebase, cherry-pick or merge a repo is stopped in, read from its git dir (worktree-aware). */
async function findInterruptedOperation(
	dir: string,
): Promise<{operation: InterruptedOperation; branch?: string} | undefined> {
	const result = await tracedExeca("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], {reject: false});
	if (result.exitCode !== 0) return undefined;
	const gitDir = result.stdout.trim();
	const has = (name: string): boolean => fs.existsSync(path.join(gitDir, name));
	for (const rebaseDir of ["rebase-merge", "rebase-apply"]) {
		if (has(rebaseDir)) return {operation: "rebase", branch: rebasingBranch(path.join(gitDir, rebaseDir))};
	}
	if (has("CHERRY_PICK_HEAD")) return {operation: "cherry-pick"};
	if (has("MERGE_HEAD")) return {operation: "merge"};
	return undefined;
}

/**
 * Abort, don't rescue: back a stuck rebase, cherry-pick or merge out to where it
 * started, as a git-write job holding the repo. The work is redone from a clean
 * state instead of patching up the halfway state: an aborted rebase reports its
 * branch as rebaseAgainBranch, whose next action is "Rebase again".
 */
export async function abortRebaseHandler(project: string): Promise<ActionResult> {
	return tracedAction("abortRebase", async () => {
		const p = await resolveProject(project);
		return runQueuedAction(project, "abortRebase", async () => {
			const interrupted = await findInterruptedOperation(p.dir);
			if (!interrupted) {
				return {ok: false, message: `No rebase, cherry-pick or merge in progress in ${project}`};
			}
			const {operation, branch} = interrupted;
			const result = await tracedExeca("git", ["-C", p.dir, operation, "--abort"], {reject: false});
			if (result.exitCode !== 0) {
				return {ok: false, message: `Failed to abort ${operation}: ${result.stderr}`};
			}
			await markRebaseFinished(project);
			invalidateChildrenCache(project);
			invalidateMergeStatus(project);
			return {ok: true, message: `Aborted ${operation} in ${project}`, rebaseAgainBranch: branch};
		});
	});
}

/**
 * Enqueues a single background rebase task for one branch, so the per-card
 * "Rebase" action runs on the shared task queue (visible on the Tasks page via
 * SSE) instead of blocking the click, consistent with "Rebase All".
 */
export async function rebaseChildHandler(data: RebaseLocalInput): Promise<TestJobStatus> {
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
		const sha = fields[0]?.trim() ?? "";
		const shortSha = nonEmpty(fields[1]?.trim()) ?? sha.slice(0, 7);
		const subject = fields[2]?.trim() ?? "";

		const task = enqueueRebase({
			project: p.name,
			projectDir: p.dir,
			sha,
			shortSha,
			subject,
			branch: data.branch,
			upstreamRemote: p.upstreamRemote,
			upstreamRef: p.upstreamRef,
			upstreamBranch: p.upstreamBranch,
			remote: p.remote,
		});
		return {id: task.id, status: task.status, message: task.message};
	});
}

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
	const projects = await ensureProjects();

	const planned: EnqueueRebaseOptions[] = [];

	for (const p of projects) {
		if (p.dirty || !p.hasTestConfigured) continue;
		if (isDashboardRepo(p.dir)) continue;

		// Sequential on purpose: readChildren may spawn git/API work, so fan-out must stay bounded
		// eslint-disable-next-line no-await-in-loop
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
				upstreamBranch: p.upstreamBranch,
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

export function launchRebaseAllChildren(): void {
	launchBackgroundEnqueue("rebaseAllChildren", rebaseAllChildrenHandler);
}

export interface RunAllCounts {
	readyToTest: number;
	needsRebase: number;
}

// Read-only estimate of how much work the "Run All Tests" / "Rebase All" buttons will
// queue, so the tasks page can show the count before the click. Runs the same
// discovery as the enqueue paths but never mutates the queue.
export async function runAllCountsHandler(): Promise<RunAllCounts> {
	return traced("runAllCounts", async () => {
		const [tests, rebases] = await Promise.all([
			planTestAll(readCachedChildren),
			planRebaseAll(readCachedChildren),
		]);
		return {readyToTest: tests.length, needsRebase: rebases.length};
	});
}

export interface RunLadderAllOptions {
	/** Override the rung implementations (tests). */
	runners?: RunLadderOptions["runners"];
	/** AI follow-up wiring override (tests); defaults to probing herdr. */
	ai?: LadderAiOptions;
	/** Project name patterns that never get an AI rung. */
	exclude?: string[];
}

/**
 * Enqueues one background ladder job per tracked (own, fork, or nested) registered project on the shared work queue. Each job
 * records its typed result as a task_records row of kind "ladder", so it survives a restart.
 */
export async function runLadderAllHandler(options: RunLadderAllOptions = {}): Promise<TestJobStatus[]> {
	return traced("runLadderAll", async () => {
		if (!inventoryExists()) {
			throw new Error(
				`No project registry at ${getInventoryPath()}; import one with \`wip inventory import\` before running the ladder on every project`,
			);
		}
		const {enqueueLadder} = await import("./task-queue.js");
		const projects = selectTrackedProjects(await ensureProjects(), loadInventory().projects);
		return projects.map((p) => {
			const task = enqueueLadder({
				project: p.name,
				projectDir: p.dir,
				upstreamRemote: p.upstreamRemote,
				upstreamBranch: p.upstreamBranch,
				dirty: p.dirty,
				detached: p.detachedHead,
				rebaseInProgress: p.rebaseInProgress,
				runners: options.runners,
				ai: matchesFilters(p.name, [], options.exclude ?? []) ? (options.ai ?? {}) : undefined,
			});
			return {id: task.id, status: task.status, message: task.message};
		});
	});
}

export interface InventoryImportOptions {
	/** Directory holding the *-template projects (default ~/projects). */
	templatesDir?: string;
	/** Home directory used to expand `~` in the templates (default os.homedir()). */
	homeDir?: string;
	/** Directories scanned for unregistered git repos (default: configured projectsDirs). */
	projectsDirs?: string[];
}

function resolveTemplatesDir(options: InventoryImportOptions): string {
	return options.templatesDir ?? path.join(os.homedir(), "projects");
}

function templateInventory(templatesDir: string, options: InventoryImportOptions) {
	return buildInventoryFromTemplates(readTemplateTexts(templatesDir), templatesDir, {
		homeDir: options.homeDir ?? os.homedir(),
	});
}

function registryModifiedAt(): string | null {
	return inventoryExists() ? fs.statSync(getInventoryPath()).mtime.toISOString() : null;
}

function inventoryStatus(options: InventoryImportOptions): InventoryStatus {
	const registryPath = getInventoryPath();
	const templatesDir = resolveTemplatesDir(options);
	const modifiedAt = registryModifiedAt();
	if (modifiedAt !== null) {
		const registry = summarizeRegistry(loadInventory().projects, modifiedAt);
		return {exists: true, registryPath, templatesDir, registry};
	}
	return {exists: false, registryPath, templatesDir, registry: null};
}

/** Whether the project registry exists, with a summary of it when it does. */
export async function getInventoryStatusHandler(options: InventoryImportOptions = {}): Promise<InventoryStatus> {
	return traced("getInventoryStatus", async () => Promise.resolve(inventoryStatus(options)));
}

function registryCandidates(options: InventoryImportOptions): RegistryCandidates {
	const baseModifiedAt = registryModifiedAt();
	const projectsDirs = options.projectsDirs ?? getProjectsDirs();
	const {projects, conflicts} =
		baseModifiedAt === null
			? templateInventory(resolveTemplatesDir(options), options)
			: {projects: loadInventory().projects, conflicts: []};
	return {
		registryPath: getInventoryPath(),
		baseModifiedAt,
		candidates: buildRegistryCandidates(projects, conflicts, projectsDirs),
	};
}

/**
 * Every project the registry review lists: the saved registry (or, before the first import, what
 * the templates would import) plus template conflicts and unregistered git repos on disk.
 */
export async function getRegistryCandidatesHandler(options: InventoryImportOptions = {}): Promise<RegistryCandidates> {
	return traced("getRegistryCandidates", async () => Promise.resolve(registryCandidates(options)));
}

export interface SaveRegistryResult {
	status: InventoryStatus;
	candidates: RegistryCandidates;
}

function saveRegistry(input: SaveRegistryInput, options: InventoryImportOptions): SaveRegistryResult {
	if (registryModifiedAt() !== input.baseModifiedAt) {
		throw new Error(`Registry at ${getInventoryPath()} changed since it was reviewed; reload and try again`);
	}
	saveInventory(input.projects);
	return {status: inventoryStatus(options), candidates: registryCandidates(options)};
}

/**
 * Writes the reviewed project list as the registry. Refuses when the registry appeared or changed
 * since the review loaded, so a stale page never overwrites someone else's edit.
 */
export async function saveRegistryHandler(
	input: SaveRegistryInput,
	options: InventoryImportOptions = {},
): Promise<SaveRegistryResult> {
	return traced("saveRegistry", async () => Promise.resolve(saveRegistry(input, options)));
}

/** The latest persisted ladder result per project. */
export async function getLadderResultsHandler(): Promise<LadderResult[]> {
	return traced("getLadderResults", async () => {
		const {getLatestLadderResults} = await import("./task-queue.js");
		return getLatestLadderResults();
	});
}

/** Focus a herdr pane; throws with herdr's message so the caller can toast it. */
export async function focusHerdrPaneHandler(
	paneId: string,
	focus: (paneId: string) => Promise<HerdrResult<undefined>> = focusHerdrPane,
): Promise<void> {
	const result = await focus(paneId);
	if (!result.ok) throw new Error(result.message);
}

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
	baselineSha?: string;
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

/**
 * Actions worth offering on a branch, given the recorded test result for its tip.
 * `testInFlight` means a test for this tip is already queued or running, so offering "test" would duplicate it.
 */
function expectedActionsForTipResult(
	result: "passed" | "failed" | undefined,
	rebaseable: boolean | null | undefined,
	testInFlight: boolean,
): AdvancePlanAction[] {
	const actions: AdvancePlanAction[] =
		result === "passed" ? ["rebase"] : result === "failed" ? ["rebase", "fix-failure"] : ["test", "rebase"];
	if (rebaseable === false) actions.push("resolve-conflicts");
	return testInFlight ? actions.filter((action) => action !== "test") : actions;
}

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
	const {getAllActiveTasks} = await import("./task-queue.js");

	for (const project of projects) {
		if (!matchesFilters(project.name, include, exclude)) continue;

		const detail = skipReason(project);
		if (detail) {
			projectSummaries.push({
				project: project.name,
				projectDir: project.dir,
				upstreamRef: project.upstreamRef,
				upstreamRemote: project.upstreamRemote,
				upstreamBranch: project.upstreamBranch,
				remote: project.remote,
				status: "skipped",
				detail,
				baselineNeedsTest: false,
				concurrency: resolveAdvanceConcurrency(project.name, project.dir),
				branches: [],
			});
			continue;
		}

		// Sequential on purpose: planning a project spawns git subprocesses, so fan-out must stay bounded
		// eslint-disable-next-line no-await-in-loop
		const plan = await planProject({project: project.name, dir: project.dir, upstreamRef: project.upstreamRef});
		const status = plan.units.length === 0 && !plan.baseline.needsTest ? "noop" : "ready";
		// eslint-disable-next-line no-await-in-loop -- sequential like planProject above, to bound git subprocesses
		const tipResults = await getGitTestStatuses(
			project.dir,
			plan.units.map((unit) => unit.tipSha),
		);
		const testShasInFlight = new Set(
			getAllActiveTasks()
				.filter((task) => task.taskType === "test" && task.project === project.name)
				.map((task) => task.sha),
		);
		const upstreamSha = getCachedUpstreamSha(project.name);
		const rebaseableBySha = new Map<string, boolean | null>(
			upstreamSha ? getCachedMergeStatuses(project.name, upstreamSha).map((ms) => [ms.sha, ms.rebaseable]) : [],
		);

		projectSummaries.push({
			project: project.name,
			projectDir: project.dir,
			upstreamRef: project.upstreamRef,
			upstreamRemote: project.upstreamRemote,
			upstreamBranch: project.upstreamBranch,
			remote: project.remote,
			status,
			baselineNeedsTest: plan.baseline.needsTest,
			baselineSha: plan.baseline.sha,
			concurrency: resolveAdvanceConcurrency(project.name, project.dir),
			branches: plan.units.map((unit) => ({
				project: unit.project,
				branch: unit.branch,
				tipSha: unit.tipSha,
				shortSha: unit.tipSha.slice(0, 7),
				ownedCommitCount: unit.chain.length,
				dependsOn: unit.dependsOn,
				worktreeRequired: unit.worktreeRequired,
				expectedActions: expectedActionsForTipResult(
					tipResults.get(unit.tipSha),
					rebaseableBySha.get(unit.tipSha),
					testShasInFlight.has(unit.tipSha),
				),
			})),
		});
	}

	return {generatedAt: Date.now(), projects: projectSummaries};
}

export async function generateAdvancePlanHandler(input: GenerateAdvancePlanInput = {}): Promise<AdvancePlanSummary> {
	return traced("generateAdvancePlan", async () => {
		const projects = await ensureProjects();
		return generateAdvancePlanForProjects(projects, input);
	});
}

export async function refreshAllHandler(): Promise<{started: number}> {
	return traced("refreshAll", async () => {
		invalidateIssuesCache();
		invalidateProjectItemsCache();
		// Drop the TTL cache and rediscover so newly cloned or removed repos are picked up.
		cachedProjects = null;
		cachedProjectsTime = 0;
		const projects = await refreshProjectCache();
		// fallow-ignore-next-line circular-dependency
		const {enqueueProjectRefresh} = await import("./background-refresh.js");
		for (const p of projects) {
			invalidatePrCache(p.name);
			enqueueProjectRefresh(p.name, {force: true});
		}
		return {started: projects.length};
	});
}

export interface SystemStatus {
	/** Epoch ms until which GitHub API calls are suppressed, or null when healthy. */
	rateLimitedUntil: number | null;
	/** Per-project children cache last-refreshed timestamps (DB format, UTC). */
	childrenRefreshedAt: Record<string, string>;
}

export async function getSystemStatusHandler(): Promise<SystemStatus> {
	return traced("getSystemStatus", async () => {
		const rateLimit = getGitHubRateLimitState();
		return Promise.resolve({
			rateLimitedUntil: rateLimit.until,
			childrenRefreshedAt: Object.fromEntries(getCacheFreshnessByPrefix("children:")),
		});
	});
}
