import {
	applyFixesToBranch,
	checkedOutBranches,
	clearAutoFix,
	clearExpiredSnoozes,
	getAutoFixes,
	reconcileAutoFixes,
	setAutoFix,
	squashFixup,
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
	getLadderBackgroundRebase,
	getSplitThresholdLines,
	getReadyBufferSize,
	getFlowStaleAfterMinutes,
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
	loadWorkItems,
	loadAllWorkItems,
	loadAllWorkItemHistory,
	flowMetrics,
	flowHistory,
	type FlowMetrics,
	type FlowHistory,
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
	type SnoozeTodoInput,
	type UnsnoozeTodoInput,
	type RunTodoTaskInput,
	snoozeTodo,
	unsnoozeTodo,
	getActiveSnoozedTodoKeys,
	todoItemKey,
	type UnsnoozeChildInput,
	type CreatePrInput,
	type CreateBranchInput,
	type DeleteBranchInput,
	type ForcePushInput,
	type RenameBranchInput,
	type ApplyFixesInput,
	type MergePrInput,
	type LandFastForwardInput,
	type RebaseLocalInput,
	type AutoFixInput,
	type AutoFix,
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
	parseWorktreeList,
} from "@wip/shared";
import {considerSplitting} from "@wip/shared/candidate-rank.js";
import {doTodoTaskPrompt} from "./category-actions.js";
import {log} from "@wip/shared/services/logger-pino.js";
import {enqueueRefresh, refreshFailureSince, refreshOutcomeMark, trackRefreshOutcome} from "./refresh-scheduler.js";
import {captureActionLogs, runQueuedAction} from "./queued-action.js";
import {repoResource} from "./repo-resource.js";
import {workQueue} from "./shared-work-queue.js";
import {runEscapeHatch, topUpReadyBuffer} from "./bulk-actions.js";
import {currentReadyBuffer} from "./ready-buffer-instance.js";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {EscapeHatchRecipe} from "./escape-hatch.js";
import {parseDiffFiles, type FileDiff} from "./diff-parser.js";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {getTracer} from "@wip/shared/services/telemetry.js";
import type {LadderAiOptions} from "./task-queue.js";
import {focusHerdrPane} from "./herdr/focus.js";
import {isLocalTestSkipped} from "./local-test-skipped.js";
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
			const autoFixes = await reconcileAutoFixes(p.dir, p.name);
			// On hold and snoozed children are returned flagged, not dropped, and get no background jobs.
			const snoozes = await resolveSnoozedChildren(p.dir, p.name, uniqueChildren);

			// Show names already suggested; naming itself is lazy (plan step 39): the ready buffer
			// names a commit entering it in a pull-request repo, and Create Branch names on demand.
			const defaultBranchPattern = /^(main|master)$/;
			const namingKeys = uniqueChildren
				.filter((c) => !snoozes.held.has(c.sha))
				.filter((c) => !c.branch || defaultBranchPattern.test(c.branch))
				.map((c) => ({sha: c.sha, project: p.name}));
			const cachedNames = namingKeys.length > 0 ? getBranchNames(namingKeys) : new Map<string, string>();

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
					parentSha: child.parentSha,
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
					// Every child carries its patch-id: the ready buffer keys one row per change by it.
					patchId: facts?.patchId === undefined || facts.patchId === "" ? undefined : facts.patchId,
					onHold: snoozes.held.has(child.sha) || undefined,
					files: facts?.files,
					insertions: facts?.insertions,
					deletions: facts?.deletions,
					considerSplitting: facts && considerSplitting(facts, splitThresholdLines) ? true : undefined,
					autoFixed: facts ? autoFixes.get(facts.patchId) : undefined,
					localTestSkipped: isLocalTestSkipped(p.name, child.sha) || undefined,
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
			const firstSeen = new Map(loadWorkItems(p.name).map((item) => [item.patchId, item.firstSeen]));
			for (const child of results) {
				const childFirstSeen = firstSeen.get(commitFacts.get(child.sha)?.patchId ?? "");
				if (child.kind !== "upstream_ci" && childFirstSeen !== undefined) child.firstSeen = childFirstSeen;
			}
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
		todoEmitter.emit("todos", {project: projectName, todos: withTodoHolds(projectName, todos)});
		return todos;
	});

	inflightTodosRefresh.set(projectName, promise);
	try {
		return await promise;
	} finally {
		inflightTodosRefresh.delete(projectName);
	}
}

/** Flags each todo On hold or snoozed from the hold table; the todos cache itself stays hold-free. */
function withTodoHolds(project: string, todos: SharedTodoItem[]): SharedTodoItem[] {
	const held = getActiveSnoozedTodoKeys(project);
	return todos.map((todo) => ({...todo, onHold: held.has(todoItemKey(todo))}));
}

export async function getProjectTodosHandler(project: string): Promise<SharedTodoItem[]> {
	return traced("getProjectTodos", async () => {
		const cached = getCachedTodos(project);
		if (cached) {
			if (!isCacheFresh(`todos:${project}`, TODOS_CACHE_TTL_MS)) enqueueTodosRefresh(project);
			return withTodoHolds(project, cached);
		}
		return withTodoHolds(project, await refreshProjectTodos(project));
	});
}

export async function snoozeTodoHandler(data: SnoozeTodoInput): Promise<ActionResult> {
	return tracedAction("snoozeTodoFn", async () => {
		snoozeTodo(data.project, todoItemKey(data), data.until);
		return Promise.resolve({ok: true, message: data.until ? `Snoozed until ${data.until}` : "On hold"});
	});
}

export async function unsnoozeTodoHandler(data: UnsnoozeTodoInput): Promise<ActionResult> {
	return tracedAction("unsnoozeTodoFn", async () => {
		unsnoozeTodo(data.project, todoItemKey(data));
		return Promise.resolve({ok: true, message: "Unsnoozed"});
	});
}

/** Queues a Claude task on the project's checked-out branch that does the given todo via markdown-tasks:do-one-task. */
export async function runTodoTaskHandler(data: RunTodoTaskInput): Promise<TestJobStatus> {
	return traced("runTodoTask", async () => {
		const p = await resolveProject(data.project);
		const branch = (await tracedExeca("git", ["-C", p.dir, "branch", "--show-current"])).stdout.trim();
		if (!branch) throw new Error(`${data.project} has a detached HEAD: check out a branch to run a todo`);
		const sha = (await tracedExeca("git", ["-C", p.dir, "rev-parse", "HEAD"])).stdout.trim();
		const {enqueueTodoTask} = await import("./task-queue.js");
		// Keyed by the todo, so a second todo queues behind the first instead of returning it.
		const task = enqueueTodoTask({
			project: data.project,
			projectDir: p.dir,
			sha,
			shortSha: sha.slice(0, 7),
			branch,
			sourceFile: data.sourceFile,
			title: data.title,
			command: doTodoTaskPrompt(data.title, path.relative(p.dir, data.sourceFile)),
		});
		return {id: task.id, status: task.status, message: task.message};
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

/** Create Branch's on-demand name (plan step 39): the cached suggestion, or one `claude -p` naming. */
export async function suggestBranchNameHandler(data: {project: string; sha: string}): Promise<{name: string | null}> {
	return traced("suggestBranchName", async () => {
		const p = await resolveProject(data.project);
		const subject = (
			await tracedExeca("git", ["-C", p.dir, "log", "-1", "--format=%s", data.sha], {reject: false})
		).stdout.trim();
		const names = await suggestBranchNames([{sha: data.sha, project: p.name, subject, dir: p.dir}]);
		return {name: names.get(`${p.name}:${data.sha}`) ?? null};
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

/**
 * Moves local `branch` forward to `sha` (the user's rule: local main only fast-forwards to verified
 * commits). Checked out in a worktree, it runs `git merge --ff-only` there, only when that worktree
 * has no local changes; otherwise `git update-ref` with the old value, so a concurrent move fails.
 * Null on success, else the reason it refused.
 */
async function fastForwardLocalBranch(dir: string, branch: string, sha: string): Promise<string | null> {
	const ref = `refs/heads/${branch}`;
	const old = await tracedExeca("git", ["-C", dir, "rev-parse", "--verify", "--quiet", ref], {reject: false});
	if (old.exitCode !== 0) return `No local ${branch} to fast-forward`;
	const oldSha = old.stdout.trim();
	const ancestor = await tracedExeca("git", ["-C", dir, "merge-base", "--is-ancestor", oldSha, sha], {
		reject: false,
	});
	if (ancestor.exitCode !== 0) return `${sha.slice(0, 7)} is not a fast-forward of local ${branch}`;
	const worktrees = await tracedExeca("git", ["-C", dir, "worktree", "list", "--porcelain"], {reject: false});
	const checkedOut = parseWorktreeList(worktrees.stdout).find((w) => w.branch === branch);
	if (checkedOut === undefined) {
		const update = await tracedExeca("git", ["-C", dir, "update-ref", ref, sha, oldSha], {reject: false});
		return update.exitCode === 0 ? null : `Failed to fast-forward local ${branch}: ${update.stderr}`;
	}
	const status = await tracedExeca("git", ["-C", checkedOut.dir, "status", "--porcelain", "--untracked-files=no"], {
		reject: false,
	});
	if (status.exitCode !== 0 || status.stdout.trim() !== "") {
		return `${branch} is checked out with local changes in ${checkedOut.dir}; commit or stash them first`;
	}
	const merge = await tracedExeca("git", ["-C", checkedOut.dir, "merge", "--ff-only", "--quiet", sha], {
		reject: false,
	});
	return merge.exitCode === 0 ? null : `Failed to fast-forward local ${branch}: ${merge.stderr}`;
}

/**
 * The fast-forward repo's landing action (lean plan step 42): fast-forward local main to the ready
 * commit first, then push main to the upstream branch without force, so git refuses anything that
 * is not a fast-forward and local main never falls behind what landed.
 */
export async function landFastForwardHandler(data: LandFastForwardInput): Promise<ActionResult> {
	return tracedAction("landFastForward", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "landFastForward", async () => {
			const refused = await fastForwardLocalBranch(p.dir, p.upstreamBranch, data.sha);
			if (refused !== null) return {ok: false, message: refused};
			const ref = `refs/heads/${p.upstreamBranch}`;
			const result = await tracedExeca("git", ["-C", p.dir, "push", p.upstreamRemote, `${ref}:${ref}`], {
				reject: false,
			});
			invalidateChildrenCache(data.project);
			invalidateMergeStatus(data.project);
			if (result.exitCode !== 0) return {ok: false, message: `Failed to land: ${result.stderr}`};
			return {ok: true, message: `Landed ${data.sha.slice(0, 7)} on ${p.upstreamRemote}/${p.upstreamBranch}`};
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

/** The auto-fix recorded for the failing commit `sha` (by its patch-id), or null. */
async function findAutoFix(dir: string, project: string, sha: string): Promise<{patchId: string; fix: AutoFix} | null> {
	const patchId = (await getCommitFacts(dir, project, [sha])).get(sha)?.patchId;
	const fix = patchId === undefined ? undefined : getAutoFixes(project).get(patchId);
	return patchId === undefined || !fix ? null : {patchId, fix};
}

export interface AutoFixReview {
	branch: string;
	fixupSha: string;
	failure: string;
	/** The fixup commit's patch. */
	diff: string;
	/** The failing run's test log (the failure the fixup fixed); null when it is gone. */
	failureLog: string | null;
}

/** The auto-fix review: the fixup's diff and the failure it fixed; null without an auto-fix. */
export async function getAutoFixReviewHandler(data: AutoFixInput): Promise<AutoFixReview | null> {
	return traced("getAutoFixReview", async () => {
		const p = await resolveProject(data.project);
		const found = await findAutoFix(p.dir, p.name, data.sha);
		if (!found) return null;
		const {fix} = found;
		const show = await tracedExeca("git", ["-C", p.dir, "show", "--format=", fix.fixupSha], {reject: false});
		const logPath = path.join(getTestLogDir(p.name), `${data.sha}.log`);
		return {
			branch: fix.branch,
			fixupSha: fix.fixupSha,
			failure: fix.failure,
			diff: show.exitCode === 0 ? show.stdout.trim() : `git show failed: ${show.stderr}`,
			failureLog: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null,
		};
	});
}

/**
 * Fix it myself: the user takes the failure over. The item stays red, the buffer leaves it alone
 * (an auto-fixed item is never pulled or re-advanced), and the fixup stays until the user decides.
 */
export async function assignAutoFixHandler(data: AutoFixInput): Promise<ActionResult> {
	return tracedAction("assignAutoFix", async () => {
		const p = await resolveProject(data.project);
		const found = await findAutoFix(p.dir, p.name, data.sha);
		if (!found) return {ok: false, message: `No auto-fix for ${data.sha}`};
		setAutoFix(p.name, found.patchId, {...found.fix, assigned: true});
		invalidateChildrenCache(p.name);
		return {ok: true, message: `The fix on ${found.fix.branch} is yours; the fixup stays until you decide`};
	});
}

/** Drop branch: delete the auto-fixed item's local branch (never a remote one) and clear its marker. */
export async function dropAutoFixBranchHandler(data: AutoFixInput): Promise<ActionResult> {
	return tracedAction("dropAutoFixBranch", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "dropAutoFixBranch", async () => {
			const found = await findAutoFix(p.dir, p.name, data.sha);
			if (!found) return {ok: false, message: `No auto-fix for ${data.sha}`};
			const {patchId, fix} = found;
			if ((await checkedOutBranches(p.dir)).has(fix.branch)) {
				return {ok: false, message: `${fix.branch} is checked out; switch away from it before dropping it`};
			}
			const deleted = await tracedExeca("git", ["-C", p.dir, "branch", "-D", fix.branch], {reject: false});
			if (deleted.exitCode !== 0) return {ok: false, message: `Failed to delete branch: ${deleted.stderr}`};
			clearAutoFix(p.name, patchId);
			invalidatePrCache(p.name);
			invalidateChildrenCache(p.name);
			invalidateMergeStatus(p.name);
			return {ok: true, message: `Deleted local branch ${fix.branch}`};
		});
	});
}

/**
 * Accept fix (lean plan step 31): fold the ready buffer's AI `fixup!` commit into the failing
 * commit with git plumbing (no checkout), as a git-write job holding the repo, and clear the
 * "auto-fixed" marker. A branch checked out in a worktree is left for the user to autosquash there.
 */
export async function acceptAutoFixHandler(data: AutoFixInput): Promise<ActionResult> {
	return tracedAction("acceptAutoFix", async () => {
		const p = await resolveProject(data.project);
		return runQueuedAction(data.project, "acceptAutoFix", async () => {
			const found = await findAutoFix(p.dir, p.name, data.sha);
			if (!found) return {ok: false, message: `No auto-fix to accept for ${data.sha}`};
			const {patchId, fix} = found;
			if ((await checkedOutBranches(p.dir)).has(fix.branch)) {
				return {
					ok: false,
					message: `${fix.branch} is checked out; accept the fix there with git rebase -i --autosquash`,
				};
			}
			const squashed = await squashFixup(p.dir, fix.branch, data.sha, fix.fixupSha);
			if (squashed === null) {
				return {ok: false, message: `${fix.branch} no longer ends in the fixup on ${data.sha}`};
			}
			clearAutoFix(p.name, patchId);
			invalidateChildrenCache(p.name);
			invalidateMergeStatus(p.name);
			return {ok: true, message: `Accepted the fix on ${fix.branch}`};
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

/** Lean plan step 37: the primary bulk action; at most target - ready - inFlight advance jobs. */
export async function topUpReadyBufferHandler(): Promise<{running: boolean}> {
	return traced("topUpReadyBuffer", async () => {
		return topUpReadyBuffer(currentReadyBuffer());
	});
}

/** The More-menu escape hatch: one of the user's global just recipes, once per project. */
export async function runEscapeHatchHandler(recipe: EscapeHatchRecipe): Promise<TestJobStatus[]> {
	return traced("runEscapeHatch", async () => {
		const handles = runEscapeHatch(recipe, {
			projects: await ensureProjects(),
			queue: workQueue,
			isDashboardRepo,
			exec: async (run, signal) =>
				tracedExeca("just", run.args, {
					cwd: run.cwd,
					// The global justfile runs `tput` at load time, which fails when TERM is unset.
					env: {...run.env, TERM: process.env["TERM"] ?? "xterm-256color"},
					extendEnv: true,
					reject: false,
					cancelSignal: signal,
				}),
			onError: (project, message) => {
				workQueue.reportJobError({kind: "escape-hatch", project, message});
			},
		});
		return handles.map((handle) => ({id: handle.id, status: "queued", message: `just ${recipe}`}));
	});
}

export interface RunLadderAllOptions {
	/** Override the rung implementations (tests). */
	runners?: RunLadderOptions["runners"];
	/** AI follow-up wiring override (tests); defaults to probing herdr. */
	ai?: LadderAiOptions;
	/** Project name patterns that never get an AI rung. */
	exclude?: string[];
	/** Run the replay and rebase-leftovers rungs; defaults to config `ladder.backgroundRebase` (off). */
	backgroundRebase?: boolean;
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
		const backgroundRebase = options.backgroundRebase ?? getLadderBackgroundRebase();
		return projects.map((p) => {
			const task = enqueueLadder({
				project: p.name,
				projectDir: p.dir,
				upstreamRemote: p.upstreamRemote,
				upstreamBranch: p.upstreamBranch,
				dirty: p.dirty,
				detached: p.detachedHead,
				rebaseInProgress: p.rebaseInProgress,
				backgroundRebase,
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
	/** How many commits the ready buffer keeps ready (readyBuffer.size): the nav strip's "ready n/slots". */
	readySlots: number;
	/** Minutes after the last completed scan before the staleness indicator turns prominent (flow.staleAfterMinutes). */
	staleAfterMinutes: number;
}

/** Flow metrics over every project's work-item ledger (plan step 45): the /queue strip and /states counts. */
export async function getFlowMetricsHandler(): Promise<FlowMetrics> {
	return Promise.resolve(flowMetrics(loadAllWorkItems(), Date.now()));
}

/** Throughput, aging and time in each state from the ledger's state history (plan step 46): the /flow page. */
export async function getFlowHistoryHandler(): Promise<FlowHistory> {
	return Promise.resolve(flowHistory(loadAllWorkItemHistory(), Date.now()));
}

/** The ready buffer's state for the Ready to land section; null when this process runs no buffer. */
export async function getReadyToLandHandler(): Promise<ReadyToLandState | null> {
	return Promise.resolve(currentReadyBuffer()?.state() ?? null);
}

export async function getSystemStatusHandler(): Promise<SystemStatus> {
	return traced("getSystemStatus", async () => {
		const rateLimit = getGitHubRateLimitState();
		// Freshness rows outlive projects that left the registry or became kind "skip"; those never
		// refresh again, so only current projects count toward how old the data is.
		const projectNames = new Set((await ensureProjects()).map((p) => p.name));
		const childrenRefreshedAt = [...getCacheFreshnessByPrefix("children:")].filter(([name]) =>
			projectNames.has(name),
		);
		return {
			rateLimitedUntil: rateLimit.until,
			childrenRefreshedAt: Object.fromEntries(childrenRefreshedAt),
			readySlots: getReadyBufferSize(),
			staleAfterMinutes: getFlowStaleAfterMinutes(),
		};
	});
}
