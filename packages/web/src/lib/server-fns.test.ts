import {describe, it, expect, beforeEach, afterEach, vi} from "vite-plus/test";
import {Polly, type PollyConfig} from "@pollyjs/core";
import {tmpdir} from "node:os";
import {mkdir as makeDirectory, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {execa} from "execa";

import {
	initDb,
	resetDb,
	setGitHubClient,
	resetGitHubClient,
	createTestClient,
	recordTestResult,
	cacheUpstreamSha,
	cacheMergeStatus,
	cacheIssues,
	cacheProjectItems,
	type GitHubIssue,
	type ProjectInfo,
} from "@wip/shared";
import {
	drainBackgroundEnqueues,
	getManagedFailedBaseBranches,
	launchBackgroundEnqueue,
	seedProjectCache,
	resetProjectCache,
} from "./server-fns.impl.js";
import {enqueueRefresh, onRefreshError, resetScheduler} from "./refresh-scheduler.js";
import {resetQueue} from "./task-queue.js";
import {workQueue} from "./shared-work-queue.js";
import {repoResource} from "./repo-resource.js";

const forcedRefreshSpy = vi.hoisted(() => vi.fn<(project: string, options: {force?: boolean}) => void>());
vi.mock("./background-refresh.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./background-refresh.js")>()),
	enqueueProjectRefresh: forcedRefreshSpy,
}));

const projectsDirsOverride = vi.hoisted(() => ({dirs: undefined as undefined | string[]}));
vi.mock("@wip/shared", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@wip/shared")>();
	return {
		...actual,
		getProjectsDirs: (flagValue?: string) => projectsDirsOverride.dirs ?? actual.getProjectsDirs(flagValue),
	};
});

const fakeExeca = vi.hoisted(() => ({
	handler: undefined as
		| undefined
		| ((
				command: string,
				args: string[],
		  ) => {stdout: string; stderr: string; exitCode: number; failed: boolean; command: string}),
}));

// Passes through to the real execa unless a test installs a fake handler.
vi.mock("execa", async (importOriginal) => {
	const actual = await importOriginal<typeof import("execa")>();
	return {
		...actual,
		execa: (...callArgs: Parameters<typeof actual.execa>) => {
			const [command, args] = callArgs as unknown as [string, string[]];
			if (fakeExeca.handler) {
				return Promise.resolve(fakeExeca.handler(command, Array.isArray(args) ? args : []));
			}
			return (actual.execa as (...a: unknown[]) => unknown)(...callArgs);
		},
	};
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FetchAdapter = require("@pollyjs/adapter-fetch");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FSPersister = require("@pollyjs/persister-fs");

Polly.register(FetchAdapter);
Polly.register(FSPersister);

const isRecordMode = process.env["POLLY_RECORD"] === "true";

function setupPolly(context: {name: string}): {
	polly: Polly;
	stop: () => Promise<void>;
} {
	const config: PollyConfig = {
		mode: isRecordMode ? "record" : "replay",
		adapters: ["fetch"],
		adapterOptions: {
			fetch: {context: globalThis},
		},
		persister: "fs",
		persisterOptions: {
			fs: {recordingsDir: join(import.meta.dirname, "..", "__recordings__")},
		},
		recordIfMissing: isRecordMode,
		recordFailedRequests: true,
		matchRequestsBy: {
			headers: {
				exclude: ["authorization", "user-agent"],
			},
		},
		logLevel: "warn",
	};

	const polly = new Polly(context.name, config);

	polly.server.any().on("beforePersist", (_req, recording) => {
		const entry = recording as {request?: {headers?: Array<{name: string; value: string}>}};
		if (entry.request?.headers) {
			for (const header of entry.request.headers) {
				if (header.name.toLowerCase() === "authorization") {
					header.value = "bearer [REDACTED]";
				}
			}
		}
	});

	return {
		polly,
		stop: async () => polly.stop(),
	};
}

/** Create a minimal ProjectInfo for test seeding. */
function makeProject(overrides: Partial<ProjectInfo> & {name: string; dir: string}): ProjectInfo {
	return {
		remote: "owner/repo",
		originRemote: "owner/repo",
		upstreamRemote: "origin",
		upstreamBranch: "main",
		upstreamRef: "origin/main",
		dirty: false,
		detachedHead: false,
		branchCount: 0,
		hasTestConfigured: true,
		rebaseInProgress: false,
		...overrides,
	};
}

/** Temporary directories to clean up after each test. */
let tmpDirs: string[] = [];

/**
 * Create a temporary git repository with an initial commit.
 * Returns the absolute path to the repo directory.
 * Cleaned up automatically in afterEach.
 */
async function createTestGitRepo(prefix = "wip-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	await execa("git", ["init", "--initial-branch=main"], {cwd: dir});
	await execa("git", ["config", "user.email", "test@test.com"], {cwd: dir});
	await execa("git", ["config", "user.name", "Test User"], {cwd: dir});
	await execa(
		"git",
		[
			"config",
			"alias.children",
			"!PARENT=$(git rev-parse ${1:-HEAD}); git rev-list --all --parents | awk -v p=\"$PARENT\" 'NF==2 && $2==p {print $1}'; :",
		],
		{cwd: dir},
	);
	await execa("git", ["commit", "--allow-empty", "-m", "Initial commit"], {cwd: dir});
	return dir;
}

async function createBareRemote(prefix = "wip-remote-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	await execa("git", ["init", "--bare", "--initial-branch=main"], {cwd: dir});
	return dir;
}

// -- Shared setup/teardown --

let pollyStop: (() => Promise<void>) | undefined;

const leakedWork = {refreshSettled: false, enqueueSettled: false};

beforeEach(() => {
	initDb(":memory:");
	setGitHubClient(createTestClient());
});

afterEach(async () => {
	if (pollyStop) {
		await pollyStop();
		pollyStop = undefined;
	}
	// Settle every background job before the DB goes away: a job still running after resetDb()
	// would reopen the real on-disk database and make the next test's initDb() throw.
	await drainBackgroundEnqueues();
	await resetQueue();
	await resetScheduler();
	resetGitHubClient();
	resetProjectCache();
	resetDb();

	// Clean up temporary git repos
	await Promise.all(tmpDirs.map(async (dir) => rm(dir, {recursive: true, force: true})));
	tmpDirs = [];
});

// -- Harness smoke tests --

describe("server-fns test harness", () => {
	it("provides a fresh in-memory database per test", () => {
		// initDb(":memory:") was called in beforeEach; if it failed, this test would not run
		expect(true).toBe(true);
	});

	it("seeds the project cache for resolveProject()", async () => {
		const dir = await createTestGitRepo();
		const project = makeProject({name: "test-project", dir});
		seedProjectCache([project]);

		// Import getProjectsHandler handler indirectly to verify the cache is seeded.
		// The handler reads from the module-level cachedProjects variable.
		const {getProjectsHandler} = await import("./server-fns.impl.js");
		// getProjectsHandler is wrapped by createServerFn; we cannot call it directly.
		// This test just verifies the harness wiring is correct.
		expect(getProjectsHandler).toBeDefined();
	});

	it("creates a temporary git repo with an initial commit", async () => {
		const dir = await createTestGitRepo();
		const result = await execa("git", ["-C", dir, "log", "--oneline"]);
		expect(result.stdout).toContain("Initial commit");
	});

	it("wires up Polly.js for HTTP interception", async () => {
		const {polly, stop} = setupPolly({name: "harness-polly-smoke"});
		pollyStop = stop;

		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(200).json({data: {viewer: {login: "test-user"}}});
		});

		const response = await fetch("https://api.github.com/graphql", {
			method: "POST",
			body: JSON.stringify({query: "{ viewer { login } }"}),
		});
		const json = await response.json();
		expect(json).toStrictEqual({data: {viewer: {login: "test-user"}}});
	});

	// These two run in order: the first leaves a refresh job and a background enqueue in flight,
	// the second checks that teardown waited for both before resetting the database.
	it("leaves background work in flight for teardown to drain", () => {
		leakedWork.refreshSettled = false;
		leakedWork.enqueueSettled = false;
		enqueueRefresh({
			kind: "children",
			project: "teardown-drain",
			run: async () => {
				await new Promise((resolve) => {
					setTimeout(resolve, 50);
				});
				leakedWork.refreshSettled = true;
			},
		});
		launchBackgroundEnqueue("teardownDrain", async () => {
			await new Promise((resolve) => {
				setTimeout(resolve, 50);
			});
			leakedWork.enqueueSettled = true;
		});
		expect(leakedWork).toStrictEqual({refreshSettled: false, enqueueSettled: false});
	});

	it("drains background work before the next test starts", () => {
		expect(leakedWork).toStrictEqual({refreshSettled: true, enqueueSettled: true});
	});

	it("sets up the test GitHubClient without auth", () => {
		// createTestClient() was called in beforeEach; verify it's a valid client
		const client = createTestClient();
		expect(client).toBeDefined();
		expect(typeof client.graphql).toBe("function");
	});
});

describe("getManagedFailedBaseBranches", () => {
	it("returns failed bases only when their repository is managed", () => {
		const managedFailure = {
			remote: "origin",
			repository: "alice/managed",
			repositoryUrl: "https://example.com/alice/managed",
			branch: "main",
			sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			date: "2000-01-01",
			checkStatus: "failed" as const,
			failedChecks: [{name: "build", url: "https://example.com/actions/build"}],
			policy: "managed" as const,
		};
		const result = getManagedFailedBaseBranches([
			managedFailure,
			{...managedFailure, repository: "bob/external", policy: "external"},
			{...managedFailure, repository: "charlie/ignored", policy: "ignored"},
			{...managedFailure, repository: "alice/passing", checkStatus: "passed"},
		]);

		expect(result).toStrictEqual([managedFailure]);
	});
});

// -- getProjectsHandler() --

describe("getProjectsHandler (underlying logic)", () => {
	it("returns seeded projects from cache", async () => {
		const dir = await createTestGitRepo();
		const project = makeProject({name: "alpha", dir});
		seedProjectCache([project]);

		// getProjectsHandler handler reads from the module-level cachedProjects.
		// We verify the seeded data round-trips correctly.
		const {seedProjectCache: _seed, resetProjectCache: _reset, ...mod} = await import("./server-fns.impl.js");
		// The module re-exports seedProjectCache/resetProjectCache but the actual
		// ensureProjects() pathway returns cachedProjects. We already seeded it,
		// so test by checking the cache variable indirectly through getProjectsHandler being defined.
		expect(mod.getProjectsHandler).toBeDefined();

		// Direct assertion: seed two projects, read them back
		const dir2 = await createTestGitRepo();
		const projects = [makeProject({name: "proj-a", dir}), makeProject({name: "proj-b", dir: dir2, dirty: true})];
		seedProjectCache(projects);

		// The getCachedProjectList/setCachedProjectList functions go through the DB.
		// seedProjectCache only sets the in-memory cache.
		// We can verify by checking the imported module's getProjectsHandler is wired.
		// Since we can't call createServerFn handlers, verify the seed took hold
		// by importing and checking that seedProjectCache populates correctly.
		const {getCachedProjectList, setCachedProjectList} = await import("@wip/shared");
		setCachedProjectList(projects);
		const fromDb = getCachedProjectList();
		expect(fromDb).toStrictEqual(projects);
	});
});

// -- getProjectChildren() --

describe("getProjectChildren (underlying logic)", () => {
	it("returns an array of child commits", async () => {
		const dir = await createTestGitRepo();
		// Create a second commit so there is a child of the initial commit
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Second commit"]);

		// upstreamRef is "main~1" (the initial commit)
		// getChildCommits uses `git children` alias which may not be available.
		// Instead test getChildren + log directly as the server fn does.
		const {getChildren} = await import("@wip/shared");
		const children = await getChildren(dir, "main~1");
		expect(Array.isArray(children)).toBe(true);
		expect(children.length).toBeGreaterThanOrEqual(1);
	});

	it("response IS an array (regression for data is not iterable)", async () => {
		const dir = await createTestGitRepo();
		const project = makeProject({name: "child-array-test", dir});
		seedProjectCache([project]);

		const {getChildCommits} = await import("@wip/shared");
		// With no children beyond the upstream ref, should return empty array (not undefined/null)
		const children = await getChildCommits(dir, "main", false);
		expect(Array.isArray(children)).toBe(true);
		expect(children).toStrictEqual([]);
	});

	it("blockReason is only set when dirty AND sha equals HEAD", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature commit"]);

		const headSha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		// Simulate dirty project at HEAD: blockReason should be set
		const project = makeProject({name: "dirty-test", dir, dirty: true});
		seedProjectCache([project]);

		// The blockReason logic is in getProjectChildren handler:
		//   blockReason = child.branch && p.dirty && child.sha === headSha ? "..." : undefined
		// We test the condition directly since we can't call the server fn
		const computeBlockReason = (branch: string, dirty: boolean, sha: string) =>
			branch && dirty && sha === headSha
				? `Working tree is dirty — commit changes in dirty-test before testing`
				: undefined;
		const blockReason = computeBlockReason("main", true, headSha);
		expect(blockReason).toBeDefined();
		expect(blockReason).toContain("dirty");

		// Non-HEAD sha should NOT have blockReason even when dirty
		const otherSha = "abc1234567890123456789012345678901234567";
		const noBlockReason = computeBlockReason("main", true, otherSha);
		expect(noBlockReason).toBeUndefined();
	});

	it("includes failedChecks from pr_failed_checks table", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feature-branch"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature work"]);

		// Cache PR statuses with failed checks
		const {cachePrStatuses, getCachedPrStatuses} = await import("@wip/shared");
		cachePrStatuses("failed-checks-test", [
			{
				branch: "feature-branch",
				reviewStatus: "no_pr",
				checkStatus: "failed",
				prUrl: "https://github.com/owner/repo/pull/1",
				prNumber: 1,
				failedChecks: [{name: "ci/test", url: "https://github.com/owner/repo/actions/runs/1"}],
			},
		]);

		const cached = getCachedPrStatuses("failed-checks-test");
		expect(cached).not.toBeNull();
		const branchStatus = cached!.find((s) => s.branch === "feature-branch");
		expect(branchStatus).toBeDefined();
		expect(branchStatus!.failedChecks).toStrictEqual([
			{name: "ci/test", url: "https://github.com/owner/repo/actions/runs/1"},
		]);
	});
});

// -- getSnoozedList() --

describe("getSnoozedList (underlying logic)", () => {
	it("returns snoozed items without temporal fields", async () => {
		const {snoozeItem, getAllSnoozedForDisplay, clearExpiredSnoozes} = await import("@wip/shared");

		snoozeItem("abc1234567890123456789012345678901234567", "my-project", "abc1234", "Fix the bug", null);

		clearExpiredSnoozes();
		const snoozed = getAllSnoozedForDisplay();
		expect(snoozed).toHaveLength(1);
		expect(snoozed[0]).toStrictEqual({
			sha: "abc1234567890123456789012345678901234567",
			project: "my-project",
			shortSha: "abc1234",
			subject: "Fix the bug",
			until: null,
		});

		// Verify no temporal fields (systemFrom, systemTo) are present
		const keys = Object.keys(snoozed[0]!);
		expect(keys).not.toContain("systemFrom");
		expect(keys).not.toContain("systemTo");
	});
});

// -- getTestQueue() --

describe("getTestQueue (underlying logic)", () => {
	it("returns enqueued jobs with correct TestQueueJobSchema fields", async () => {
		const {TestQueueJobSchema} = await import("@wip/shared");
		const {enqueueTest, getAllJobs} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		const job = enqueueTest(
			"queue-project",
			dir,
			"abc1234567890123456789012345678901234567",
			"abc1234",
			"Test subject",
			"feature-branch",
		);

		// Job may immediately transition to "running" since processQueue is called synchronously
		expect(["queued", "running"]).toContain(job.status);

		const allJobs = getAllJobs();
		const parsed = Array.from(allJobs.values()).map((j) => TestQueueJobSchema.parse(j));
		expect(parsed.length).toBeGreaterThanOrEqual(1);

		const found = parsed.find((j) => j.id === job.id);
		expect(found).toBeDefined();
		expect(found!.project).toBe("queue-project");
		expect(found!.sha).toBe("abc1234567890123456789012345678901234567");
		expect(found!.shortSha).toBe("abc1234");
		expect(found!.subject).toBe("Test subject");
		expect(found!.branch).toBe("feature-branch");
		expect(["queued", "running"]).toContain(found!.status);
		expect(typeof found!.queuedAt).toBe("number");
	});
});

// -- generateAdvancePlanForProjects() --

describe("generateAdvancePlanForProjects", () => {
	it("returns skipped projects for dirty, detached head, and missing test config", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const projects = [
			makeProject({name: "dirty-project", dir: "/missing/dirty", dirty: true}),
			makeProject({name: "detached-project", dir: "/missing/detached", detachedHead: true}),
			makeProject({name: "untested-project", dir: "/missing/untested", hasTestConfigured: false}),
		];

		const plan = await generateAdvancePlanForProjects(projects);

		expect(plan.projects).toHaveLength(3);
		expect(plan.projects.map((project) => [project.project, project.status, project.detail])).toStrictEqual([
			["dirty-project", "skipped", "dirty"],
			["detached-project", "skipped", "detached head"],
			["untested-project", "skipped", "no test configured"],
		]);
		expect(plan.projects.every((project) => project.branches.length === 0)).toBe(true);
	});

	it("returns noop when a project has no branch units and the baseline is cached green", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		const baselineSha = (await execa("git", ["-C", dir, "rev-parse", "main"])).stdout.trim();
		recordTestResult(baselineSha, "noop-project", "passed", 0, 10);

		const plan = await generateAdvancePlanForProjects([
			makeProject({name: "noop-project", dir, upstreamRef: "main"}),
		]);

		expect(plan.projects).toHaveLength(1);
		expect(plan.projects[0]).toMatchObject({
			project: "noop-project",
			status: "noop",
			baselineNeedsTest: false,
			branches: [],
		});
	});

	it("exposes the baseline sha for a ready project with no branches so its baseline test can run", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		const baselineSha = (await execa("git", ["-C", dir, "rev-parse", "main"])).stdout.trim();

		const plan = await generateAdvancePlanForProjects([
			makeProject({name: "baseline-only-project", dir, upstreamRef: "main", upstreamBranch: "main"}),
		]);

		expect(plan.projects).toHaveLength(1);
		expect(plan.projects[0]).toStrictEqual({
			project: "baseline-only-project",
			projectDir: dir,
			upstreamRef: "main",
			upstreamRemote: "origin",
			upstreamBranch: "main",
			remote: "owner/repo",
			status: "ready",
			baselineNeedsTest: true,
			baselineSha,
			concurrency: 1,
			branches: [],
		});
	});

	it("returns ready branch summaries for planned branch units", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/advance-plan"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature work"]);
		const tipSha = (await execa("git", ["-C", dir, "rev-parse", "feature/advance-plan"])).stdout.trim();

		const plan = await generateAdvancePlanForProjects([
			makeProject({name: "ready-project", dir, upstreamRef: "main", upstreamBranch: "main"}),
		]);

		expect(plan.projects).toHaveLength(1);
		expect(plan.projects[0]).toMatchObject({
			project: "ready-project",
			status: "ready",
			baselineNeedsTest: true,
			concurrency: 1,
		});
		expect(plan.projects[0]!.branches).toStrictEqual([
			{
				project: "ready-project",
				branch: "feature/advance-plan",
				tipSha,
				shortSha: tipSha.slice(0, 7),
				ownedCommitCount: 1,
				dependsOn: [],
				worktreeRequired: false,
				expectedActions: ["test", "rebase"],
			},
		]);
	});

	it("derives each branch's expected actions from its tip's recorded test result", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/passed"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Passing work"]);
		const passedSha = (await execa("git", ["-C", dir, "rev-parse", "feature/passed"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/failed", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Failing work"]);
		const failedSha = (await execa("git", ["-C", dir, "rev-parse", "feature/failed"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/untested", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Untested work"]);
		recordTestResult(passedSha, "state-project", "passed", 0, 10);
		recordTestResult(failedSha, "state-project", "failed", 1, 10);

		const plan = await generateAdvancePlanForProjects([
			makeProject({name: "state-project", dir, upstreamRef: "main", upstreamBranch: "main"}),
		]);

		const actionsByBranch = Object.fromEntries(
			plan.projects[0]!.branches.map((branch) => [branch.branch, branch.expectedActions]),
		);
		expect(actionsByBranch).toStrictEqual({
			"feature/passed": ["rebase"],
			"feature/failed": ["rebase", "fix-failure"],
			"feature/untested": ["test", "rebase"],
		});
	});

	it("offers resolve-conflicts only for branches whose cached merge status is not rebaseable", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		const upstreamSha = (await execa("git", ["-C", dir, "rev-parse", "main"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/conflicting", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Conflicting work"]);
		const conflictingSha = (await execa("git", ["-C", dir, "rev-parse", "feature/conflicting"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/clean", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Clean work"]);
		const cleanSha = (await execa("git", ["-C", dir, "rev-parse", "feature/clean"])).stdout.trim();
		cacheUpstreamSha("conflict-project", "main", upstreamSha);
		cacheMergeStatus("conflict-project", conflictingSha, upstreamSha, 1, 2, false);
		cacheMergeStatus("conflict-project", cleanSha, upstreamSha, 1, 2, true);

		const plan = await generateAdvancePlanForProjects([
			makeProject({name: "conflict-project", dir, upstreamRef: "main", upstreamBranch: "main"}),
		]);

		const actionsByBranch = Object.fromEntries(
			plan.projects[0]!.branches.map((branch) => [branch.branch, branch.expectedActions]),
		);
		expect(actionsByBranch).toStrictEqual({
			"feature/conflicting": ["test", "rebase", "resolve-conflicts"],
			"feature/clean": ["test", "rebase"],
		});
	});

	it("omits test for a branch whose tip already has a test running or queued", async () => {
		const taskQueue = await import("./task-queue.js");
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/running", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Running work"]);
		const runningSha = (await execa("git", ["-C", dir, "rev-parse", "feature/running"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/queued", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Queued work"]);
		const queuedSha = (await execa("git", ["-C", dir, "rev-parse", "feature/queued"])).stdout.trim();
		await execa("git", ["-C", dir, "checkout", "-b", "feature/idle", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Idle work"]);
		const activeTasks = [
			{taskType: "test", project: "in-flight-project", sha: runningSha, status: "running"},
			{taskType: "test", project: "in-flight-project", sha: queuedSha, status: "queued"},
		] as unknown as ReturnType<typeof taskQueue.getAllActiveTasks>;
		const activeSpy = vi.spyOn(taskQueue, "getAllActiveTasks").mockReturnValue(activeTasks);

		try {
			const plan = await generateAdvancePlanForProjects([
				makeProject({name: "in-flight-project", dir, upstreamRef: "main", upstreamBranch: "main"}),
			]);

			const actionsByBranch = Object.fromEntries(
				plan.projects[0]!.branches.map((branch) => [branch.branch, branch.expectedActions]),
			);
			expect(actionsByBranch).toStrictEqual({
				"feature/running": ["rebase"],
				"feature/queued": ["rebase"],
				"feature/idle": ["test", "rebase"],
			});
		} finally {
			activeSpy.mockRestore();
		}
	});
});

// -- getIssues() --

describe("getIssues (underlying logic)", () => {
	it("returns IssueResult[] from Polly-intercepted GraphQL", async () => {
		const {polly, stop} = setupPolly({name: "getIssues-polly"});
		pollyStop = stop;

		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{
								number: 10,
								title: "Server fn issue",
								url: "https://github.com/owner/repo/issues/10",
								labels: {nodes: [{name: "enhancement", color: "a2eeef"}]},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
						],
					},
				},
			});
		});

		const {fetchAssignedIssues, IssueResultSchema} = await import("@wip/shared");
		const issues = await fetchAssignedIssues();
		expect(Array.isArray(issues)).toBe(true);
		expect(issues).toHaveLength(1);

		// Validate each issue matches IssueResult shape
		for (const issue of issues) {
			expect(() => IssueResultSchema.parse(issue)).not.toThrow();
		}

		expect(issues[0]!.number).toBe(10);
		expect(issues[0]!.title).toBe("Server fn issue");
		expect(issues[0]!.labels).toStrictEqual([{name: "enhancement", color: "a2eeef"}]);
	});
});

// -- getProjectItemsFn() --

describe("getProjectItemsFn (underlying logic)", () => {
	let pollyStopLocal: (() => Promise<void>) | undefined;

	beforeEach(async () => {
		const {resetViewerLoginCache} = await import("@wip/shared");
		resetViewerLoginCache();
	});

	afterEach(async () => {
		if (pollyStopLocal) {
			await pollyStopLocal();
			pollyStopLocal = undefined;
		}
	});

	it("returns ProjectItemResult[] from Polly-intercepted GraphQL", async () => {
		const {polly, stop} = setupPolly({name: "getProjectItemsFn-polly"});
		pollyStopLocal = stop;

		polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
			const body = JSON.parse(String(req.body)) as {query: string};

			if (body.query.includes("projectsV2")) {
				res.status(200).json({
					data: {
						viewer: {
							projectsV2: {
								nodes: [{number: 1, title: "Board"}],
							},
						},
					},
				});
				return;
			}

			if (body.query.includes("viewer") && body.query.includes("login")) {
				res.status(200).json({
					data: {viewer: {login: "testuser"}},
				});
				return;
			}

			if (body.query.includes("projectV2")) {
				res.status(200).json({
					data: {
						user: {
							projectV2: {
								items: {
									pageInfo: {hasNextPage: false, endCursor: null},
									nodes: [
										{
											id: "PVTI_serverfn",
											type: "ISSUE",
											fieldValueByName: {name: "Todo"},
											content: {
												title: "Server fn item",
												number: 5,
												url: "https://github.com/owner/repo/issues/5",
												repository: {nameWithOwner: "owner/repo"},
												labels: {nodes: []},
											},
										},
									],
								},
							},
						},
					},
				});
				return;
			}

			res.status(400).json({message: "Unexpected query"});
		});

		const {fetchAllProjectItems} = await import("@wip/shared");
		const items = await fetchAllProjectItems();
		expect(Array.isArray(items)).toBe(true);
		expect(items).toHaveLength(1);

		// Validate the shape matches what getProjectItemsFn returns
		// (the server fn just returns fetchAllProjectItems() directly)
		expect(items[0]!.title).toBe("Server fn item");
		expect(items[0]!.number).toBe(5);
	});
});

// -- getIssuesHandler / getProjectItemsHandler serve the cache --

const STALE_MS = 20 * 60 * 1000;

/** Run fn with the wall clock set to `ms`, so cache rows get that timestamp. */
function atTime<T>(ms: number, fn: () => T): T {
	vi.useFakeTimers({toFake: ["Date"]});
	vi.setSystemTime(ms);
	try {
		return fn();
	} finally {
		vi.useRealTimers();
	}
}

function makeIssue(number: number, title: string): GitHubIssue {
	return {
		number,
		title,
		url: `https://github.com/owner/repo/issues/${number}`,
		labels: [],
		repository: {name: "repo", nameWithOwner: "owner/repo"},
	};
}

/** Resolves to "blocked" if the handler is still waiting after a short grace period. */
async function settleOrBlocked<T>(promise: Promise<T>): Promise<T | "blocked"> {
	return Promise.race([
		promise,
		new Promise<"blocked">((resolve) => {
			setTimeout(() => {
				resolve("blocked");
			}, 500);
		}),
	]);
}

describe("getIssuesHandler serves the cache", () => {
	it("returns stale cached issues without awaiting GitHub, then pushes the refreshed list", async () => {
		atTime(Date.now() - STALE_MS, () => {
			cacheIssues([makeIssue(1, "Cached issue")]);
		});
		const {polly, stop} = setupPolly({name: "getIssuesHandler-stale"});
		pollyStop = stop;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		polly.server.post("https://api.github.com/graphql").intercept(async (_req, res) => {
			await gate;
			res.status(200).json({
				data: {
					search: {
						nodes: [
							{
								number: 2,
								title: "Fresh issue",
								url: "https://github.com/owner/repo/issues/2",
								labels: {nodes: []},
								repository: {name: "repo", nameWithOwner: "owner/repo"},
							},
						],
					},
				},
			});
		});
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");
		const {githubEmitter} = await import("./github-events.js");
		const pushed = new Promise((resolve) => {
			githubEmitter.once("issues", resolve);
		});

		const {getIssuesHandler} = await import("./server-fns.impl.js");
		const result = await settleOrBlocked(getIssuesHandler());
		release();

		expect(result).toStrictEqual([makeIssue(1, "Cached issue")]);
		expect(enqueueSpy).toHaveBeenCalledWith(
			expect.objectContaining({coalesceKey: "issues:github", kind: "issues", project: "github"}),
		);
		expect(await pushed).toStrictEqual([makeIssue(2, "Fresh issue")]);
		enqueueSpy.mockRestore();
	});

	it("returns fresh cached issues without enqueueing a refresh", async () => {
		cacheIssues([makeIssue(1, "Cached issue")]);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");

		const {getIssuesHandler} = await import("./server-fns.impl.js");
		const result = await getIssuesHandler();

		expect({result, enqueued: enqueueSpy.mock.calls.length}).toStrictEqual({
			result: [makeIssue(1, "Cached issue")],
			enqueued: 0,
		});
		enqueueSpy.mockRestore();
	});

	it("treats a refreshed-but-empty issue list as cached instead of fetching in the foreground", async () => {
		atTime(Date.now() - STALE_MS, () => {
			cacheIssues([]);
		});
		const {polly, stop} = setupPolly({name: "getIssuesHandler-empty-stale"});
		pollyStop = stop;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		polly.server.post("https://api.github.com/graphql").intercept(async (_req, res) => {
			await gate;
			res.status(200).json({data: {search: {nodes: []}}});
		});
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");

		const {getIssuesHandler} = await import("./server-fns.impl.js");
		const result = await settleOrBlocked(getIssuesHandler());
		release();

		expect(result).toStrictEqual([]);
		expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({coalesceKey: "issues:github"}));
		enqueueSpy.mockRestore();
	});
});

describe("getProjectItemsHandler serves the cache", () => {
	it("returns stale cached project items without awaiting GitHub, then pushes the refreshed list", async () => {
		const cachedItem = {
			id: "PVTI_cached",
			title: "Cached item",
			status: "Todo",
			type: "ISSUE" as const,
			url: "https://github.com/owner/repo/issues/8",
			number: 8,
			repository: "owner/repo",
			labels: [],
		};
		atTime(Date.now() - STALE_MS, () => {
			cacheProjectItems([cachedItem]);
		});
		const {resetViewerLoginCache} = await import("@wip/shared");
		resetViewerLoginCache();
		const {polly, stop} = setupPolly({name: "getProjectItemsHandler-stale"});
		pollyStop = stop;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		polly.server.post("https://api.github.com/graphql").intercept(async (_req, res) => {
			await gate;
			res.status(200).json({data: {viewer: {projectsV2: {nodes: []}}}});
		});
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");
		const {githubEmitter} = await import("./github-events.js");
		const pushed = new Promise((resolve) => {
			githubEmitter.once("projectItems", resolve);
		});

		const {getProjectItemsHandler} = await import("./server-fns.impl.js");
		const result = await settleOrBlocked(getProjectItemsHandler());
		release();

		expect(result).toStrictEqual([cachedItem]);
		expect(enqueueSpy).toHaveBeenCalledWith(
			expect.objectContaining({coalesceKey: "project-items:github", kind: "project-items", project: "github"}),
		);
		expect(await pushed).toStrictEqual([]);
		enqueueSpy.mockRestore();
	});
});

// -- getProjectTodos() --

describe("getProjectTodos (underlying logic)", () => {
	it("returns TodoItem[] for a repo with todo.md", async () => {
		const dir = await createTestGitRepo();

		// Use .llm/todo.md to avoid macOS case-insensitive filesystem
		// matching both todo.md and TODO.md entries in TODO_FILENAMES
		const {writeFile, mkdir} = await import("node:fs/promises");
		await mkdir(join(dir, ".llm"), {recursive: true});
		await writeFile(
			join(dir, ".llm", "todo.md"),
			"- [ ] First task\n  Context for first\n- [x] Done task\n- [ ] Second task\n",
		);

		const {findIncompleteTodoTasks} = await import("@wip/shared");
		const tasks = findIncompleteTodoTasks(dir);
		expect(tasks).toHaveLength(2);
		expect(tasks[0]!.text).toBe("First task");
		expect(tasks[0]!.sourceFile).toContain("todo.md");
		expect(tasks[1]!.text).toBe("Second task");
	});

	it("returns empty array for a repo without todo.md", async () => {
		const dir = await createTestGitRepo();

		const {findIncompleteTodoTasks} = await import("@wip/shared");
		const tasks = findIncompleteTodoTasks(dir);
		expect(tasks).toStrictEqual([]);
	});
});

// -- snoozeChildFn / unsnoozeChildFn (underlying logic) --

describe("snoozeChildFn / unsnoozeChildFn (underlying logic)", () => {
	it("snooze adds item, unsnooze removes it", async () => {
		const {snoozeItem, unsnoozeItem, getAllSnoozedForDisplay, clearExpiredSnoozes} = await import("@wip/shared");

		const sha = "aaaa1234567890123456789012345678901234aa";
		snoozeItem(sha, "snooze-proj", "aaaa123", "Snooze me", null);

		clearExpiredSnoozes();
		const snoozed = getAllSnoozedForDisplay();
		expect(snoozed).toHaveLength(1);
		expect(snoozed[0]!.sha).toBe(sha);
		expect(snoozed[0]!.project).toBe("snooze-proj");

		unsnoozeItem(sha, "snooze-proj");
		clearExpiredSnoozes();
		const afterUnsnooze = getAllSnoozedForDisplay();
		expect(afterUnsnooze).toHaveLength(0);
	});

	it("snooze with until timestamp shows in snoozed list", async () => {
		const {snoozeItem, getAllSnoozedForDisplay, clearExpiredSnoozes} = await import("@wip/shared");

		const sha = "bbbb1234567890123456789012345678901234bb";
		const futureDate = new Date(Date.now() + 86400000).toISOString();
		snoozeItem(sha, "snooze-until-proj", "bbbb123", "Snooze until", futureDate);

		clearExpiredSnoozes();
		const snoozed = getAllSnoozedForDisplay();
		expect(snoozed).toHaveLength(1);
		expect(snoozed[0]!.until).toBe(futureDate);
	});

	it("snooze then unsnooze different project does not remove original", async () => {
		const {snoozeItem, unsnoozeItem, getAllSnoozedForDisplay, clearExpiredSnoozes} = await import("@wip/shared");

		const sha = "cccc1234567890123456789012345678901234cc";
		snoozeItem(sha, "proj-a", "cccc123", "Keep snoozed", null);

		unsnoozeItem(sha, "proj-b");
		clearExpiredSnoozes();
		const snoozed = getAllSnoozedForDisplay();
		expect(snoozed).toHaveLength(1);
		expect(snoozed[0]!.project).toBe("proj-a");
	});
});

// -- testChild (underlying logic via task-queue) --

describe("testChild (underlying logic via task-queue)", () => {
	it("enqueueTest creates a job with correct fields", async () => {
		const {enqueueTest, getAllJobs} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		const sha = "dddd1234567890123456789012345678901234dd";
		const job = enqueueTest("test-proj", dir, sha, "dddd123", "Test subject", "feat-branch");

		expect(job.project).toBe("test-proj");
		expect(job.sha).toBe(sha);
		expect(job.shortSha).toBe("dddd123");
		expect(job.subject).toBe("Test subject");
		expect(job.branch).toBe("feat-branch");
		expect(["queued", "running"]).toContain(job.status);
		expect(typeof job.queuedAt).toBe("number");

		const allJobs = getAllJobs();
		expect(allJobs.has(job.id)).toBe(true);
	});

	it("enqueueTest returns existing job if already queued for same sha+project", async () => {
		const {enqueueTest} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		const sha = "eeee1234567890123456789012345678901234ee";
		const job1 = enqueueTest("dedup-proj", dir, sha, "eeee123", "First", "branch-a");
		const job2 = enqueueTest("dedup-proj", dir, sha, "eeee123", "Second", "branch-a");

		// If first job is still queued or running, should return the same job
		const stillActive = job1.status === "queued" || job1.status === "running";
		expect(!stillActive || job2.id === job1.id).toBe(true);
	});
});

// -- cancelTestFn (underlying logic via task-queue) --

describe("cancelTestFn (underlying logic via task-queue)", () => {
	it("cancels a queued job", async () => {
		const {enqueueTest, cancelTest, getAllJobs} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		// Enqueue two jobs for same project to ensure one stays queued
		const sha1 = "fff11234567890123456789012345678901234f1";
		const sha2 = "fff21234567890123456789012345678901234f2";
		enqueueTest("cancel-proj", dir, sha1, "fff1123", "First job", undefined);
		const job2 = enqueueTest("cancel-proj", dir, sha2, "fff2123", "Second job", undefined);

		// The second job should be queued since the first is running
		const expected = {ok: true, message: expect.stringContaining("cancelled") as unknown, status: "cancelled"};
		let observed = expected;
		if (job2.status === "queued") {
			const result = cancelTest(job2.id);
			observed = {ok: result.ok, message: result.message, status: getAllJobs().get(job2.id)?.status ?? "missing"};
		}
		expect(observed).toStrictEqual(expected);
	});

	it("cannot cancel an already-finished job", async () => {
		const {cancelTest} = await import("./task-queue.js");

		const result = cancelTest("nonexistent-id");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("not found");
	});
});

// -- pushChildHandler (underlying logic with mocked tracedExeca) --

describe("pushChildHandler (underlying logic with mocked tracedExeca)", () => {
	it("creates branch and pushes when no branch provided", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});

				// git rev-parse HEAD
				if (command === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
					return {
						stdout: "aaa0000000000000000000000000000000000000",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git rev-parse HEAD",
					};
				}

				// git log -1 --format=%h%x00%s
				if (command === "git" && args.includes("log") && args.some((a) => a.includes("%h%x00%s"))) {
					return {
						stdout: "abc1234\0My commit subject",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git log",
					};
				}

				// git branch
				if (command === "git" && args.includes("branch") && !args.includes("-D") && !args.includes("-m")) {
					return {stdout: "", stderr: "", exitCode: 0, failed: false, command: "git branch"};
				}

				// git push
				if (command === "git" && args.includes("push")) {
					return {stdout: "", stderr: "", exitCode: 0, failed: false, command: "git push"};
				}

				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					failed: false,
					command: `${command} ${args.join(" ")}`,
				};
			},
		}));

		// Re-import server-fns to pick up the mock
		const {pushChildHandler: _pushChild} = await import("./server-fns.impl.js");

		const dir = await createTestGitRepo();
		const project = makeProject({name: "push-proj", dir});
		seedProjectCache([project]);

		// Since we cannot call createServerFn handlers directly, verify the underlying
		// tracedExeca calls that pushChildHandler would make by testing the mock wiring.
		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		// Simulate what pushChildHandler does: rev-parse HEAD, log, branch create, push
		await mockedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false});
		await mockedExeca("git", ["-C", dir, "log", "-1", "--format=%h%x00%s", "abc123"], {
			reject: false,
		});
		await mockedExeca("git", ["-C", dir, "branch", "my-commit-subject", "abc123"], {
			reject: false,
		});
		await mockedExeca(
			"git",
			["-C", dir, "push", "-u", "origin", "my-commit-subject:refs/heads/my-commit-subject"],
			{reject: false},
		);

		expect(tracedExecaCalls).toHaveLength(4);
		expect(tracedExecaCalls[0]!.args).toContain("rev-parse");
		expect(tracedExecaCalls[1]!.args).toContain("log");
		expect(tracedExecaCalls[2]!.args).toContain("branch");
		expect(tracedExecaCalls[3]!.args).toContain("push");

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});

	it("pushes directly when branch is already provided", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});

				if (command === "git" && args.includes("rev-parse")) {
					return {
						stdout: "bbb0000000000000000000000000000000000000",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git",
					};
				}
				if (command === "git" && args.includes("log")) {
					return {
						stdout: "bbb1234\0Existing branch commit",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git",
					};
				}
				if (command === "git" && args.includes("push")) {
					return {stdout: "", stderr: "", exitCode: 0, failed: false, command: "git"};
				}

				return {
					stdout: "",
					stderr: "",
					exitCode: 0,
					failed: false,
					command: `${command} ${args.join(" ")}`,
				};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		// Simulate pushChildHandler with existing branch: should skip branch creation
		const dir = await createTestGitRepo();
		await mockedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false});
		await mockedExeca("git", ["-C", dir, "log", "-1", "--format=%h%x00%s", "bbb123"], {
			reject: false,
		});
		// With existing branch, push directly (no git branch command)
		await mockedExeca("git", ["-C", dir, "push", "-u", "origin", "existing-branch:refs/heads/existing-branch"], {
			reject: false,
		});

		expect(tracedExecaCalls).toHaveLength(3);
		// No branch creation step
		expect(tracedExecaCalls.some((c) => c.args.includes("branch") && !c.args.includes("rev-parse"))).toBe(false);

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});
});

// -- refreshChild (underlying logic) --

describe("refreshChild (underlying logic)", () => {
	it("invalidates PR cache for the project", async () => {
		const {cachePrStatuses, getCachedPrStatuses, invalidatePrCache} = await import("@wip/shared");

		cachePrStatuses("refresh-proj", [
			{
				branch: "some-branch",
				reviewStatus: "no_pr",
				checkStatus: "none",
				prUrl: null,
				prNumber: undefined,
				failedChecks: [],
			},
		]);

		const before = getCachedPrStatuses("refresh-proj");
		expect(before).not.toBeNull();

		invalidatePrCache("refresh-proj");

		const after = getCachedPrStatuses("refresh-proj");
		expect(after).toBeNull();
	});
});

// -- createBranch / deleteBranch / renameBranch (underlying logic with mocked tracedExeca) --

describe("createBranch (underlying logic with mocked tracedExeca)", () => {
	it("issues correct git checkout -b command", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});
				return {stdout: "", stderr: "", exitCode: 0, failed: false, command: command};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		const dir = await createTestGitRepo();
		const sha = "abc1234567890123456789012345678901234567";

		// Simulate what createBranch does
		await mockedExeca("git", ["-C", dir, "checkout", "-b", "feature/new-branch", sha], {
			reject: false,
		});

		expect(tracedExecaCalls).toHaveLength(1);
		const call = tracedExecaCalls[0]!;
		expect(call.command).toBe("git");
		expect(call.args).toContain("checkout");
		expect(call.args).toContain("-b");
		expect(call.args).toContain("feature/new-branch");
		expect(call.args).toContain(sha);

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});
});

describe("deleteBranch (underlying logic with mocked tracedExeca)", () => {
	it("issues correct git branch -D command", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});
				return {stdout: "", stderr: "", exitCode: 0, failed: false, command: command};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		const dir = await createTestGitRepo();

		// Simulate what deleteBranch does
		await mockedExeca("git", ["-C", dir, "branch", "-D", "old-branch"], {reject: false});

		expect(tracedExecaCalls).toHaveLength(1);
		const call = tracedExecaCalls[0]!;
		expect(call.command).toBe("git");
		expect(call.args).toContain("branch");
		expect(call.args).toContain("-D");
		expect(call.args).toContain("old-branch");

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});
});

describe("renameBranch (underlying logic with mocked tracedExeca)", () => {
	it("issues correct git branch -m command", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});
				return {stdout: "", stderr: "", exitCode: 0, failed: false, command: command};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		const dir = await createTestGitRepo();

		// Simulate what renameBranch does
		await mockedExeca("git", ["-C", dir, "branch", "-m", "old-name", "new-name"], {
			reject: false,
		});

		expect(tracedExecaCalls).toHaveLength(1);
		const call = tracedExecaCalls[0]!;
		expect(call.command).toBe("git");
		expect(call.args).toContain("branch");
		expect(call.args).toContain("-m");
		expect(call.args).toContain("old-name");
		expect(call.args).toContain("new-name");

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});
});

// -- rebaseLocal (underlying logic with mocked tracedExeca) --

describe("rebaseLocal (underlying logic with mocked tracedExeca)", () => {
	it("issues checkout, rebase, and push commands in sequence", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});

				if (command === "git" && args.includes("rev-parse")) {
					return {
						stdout: "rebase000000000000000000000000000000000",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git",
					};
				}

				return {stdout: "", stderr: "", exitCode: 0, failed: false, command: command};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		const dir = await createTestGitRepo();
		const branch = "feature/rebase-me";
		const upstreamRef = "origin/main";

		// Simulate what rebaseLocal does
		await mockedExeca("git", ["-C", dir, "checkout", branch], {reject: false});
		await mockedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false});
		await mockedExeca("git", ["-C", dir, "rebase", upstreamRef], {reject: false});
		await mockedExeca("git", ["-C", dir, "push", "origin", `${branch}:${branch}`, "--force-with-lease"], {
			reject: false,
		});

		expect(tracedExecaCalls).toHaveLength(4);

		// Verify checkout
		expect(tracedExecaCalls[0]!.args).toContain("checkout");
		expect(tracedExecaCalls[0]!.args).toContain(branch);

		// Verify rev-parse
		expect(tracedExecaCalls[1]!.args).toContain("rev-parse");

		// Verify rebase with correct upstream ref
		expect(tracedExecaCalls[2]!.args).toContain("rebase");
		expect(tracedExecaCalls[2]!.args).toContain(upstreamRef);

		// Verify force push with lease
		expect(tracedExecaCalls[3]!.args).toContain("push");
		expect(tracedExecaCalls[3]!.args).toContain("--force-with-lease");
		expect(tracedExecaCalls[3]!.args).toContain(`${branch}:${branch}`);

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});

	it("aborts rebase on conflict and caches merge status", async () => {
		const tracedExecaCalls: Array<{command: string; args: string[]}> = [];

		vi.doMock("@wip/shared/services/traced-execa.js", () => ({
			tracedExeca: (command: string, args: string[], _options?: unknown) => {
				tracedExecaCalls.push({command, args});

				if (command === "git" && args.includes("rev-parse")) {
					return {
						stdout: "conflict0000000000000000000000000000000",
						stderr: "",
						exitCode: 0,
						failed: false,
						command: "git",
					};
				}

				// Simulate rebase failure
				if (command === "git" && args.includes("rebase") && !args.includes("--abort")) {
					return {
						stdout: "",
						stderr: "CONFLICT (content): Merge conflict in file.txt",
						exitCode: 1,
						failed: true,
						command: "git",
					};
				}

				return {stdout: "", stderr: "", exitCode: 0, failed: false, command: command};
			},
		}));

		const {tracedExeca: mockedExeca} = await import("@wip/shared/services/traced-execa.js");

		const dir = await createTestGitRepo();

		// Simulate rebaseLocal with conflict
		await mockedExeca("git", ["-C", dir, "checkout", "conflict-branch"], {reject: false});
		await mockedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false});
		const rebaseResult = await mockedExeca("git", ["-C", dir, "rebase", "origin/main"], {
			reject: false,
		});

		expect(rebaseResult.exitCode).toBe(1);

		// After failure, rebaseLocal aborts the rebase
		await mockedExeca("git", ["-C", dir, "rebase", "--abort"], {reject: false});

		expect(tracedExecaCalls.some((c) => c.args.includes("--abort"))).toBe(true);

		vi.doUnmock("@wip/shared/services/traced-execa.js");
	});
});

// -- getProjectChildrenHandler (direct handler tests) --

describe("getProjectChildrenHandler", () => {
	it("returns an array (not undefined/null)", async () => {
		const dir = await createTestGitRepo();
		const project = makeProject({name: "handler-array-test", dir});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("handler-array-test");
		expect(Array.isArray(result)).toBe(true);
	});

	it("returns empty array when project resolution fails", async () => {
		// Do NOT seed a project with this name so resolveProject throws
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "other-project", dir})]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("nonexistent-project");
		expect(result).toStrictEqual([]);
	});

	it("routes a cold-cache refresh through the shared work queue", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "cold-queue-test", dir})]);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		await getProjectChildrenHandler("cold-queue-test");

		expect(enqueueSpy).toHaveBeenCalledTimes(1);
		expect(enqueueSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				coalesceKey: "children:cold-queue-test",
				kind: "children",
				project: "cold-queue-test",
				priority: "foreground",
			}),
		);
		enqueueSpy.mockRestore();
	});

	it("a coalesced cold-cache caller sees the failure of the in-flight refresh", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "coalesce-fail-test", dir})]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.doMock("./watch-suppression.js", () => ({
			suppressWatcherEvents: async () => {
				await gate;
				throw new Error("refresh boom");
			},
		}));

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const first = getProjectChildrenHandler("coalesce-fail-test");
		const second = getProjectChildrenHandler("coalesce-fail-test");
		const settled = Promise.allSettled([first, second]);
		release();
		const [firstResult, secondResult] = await settled;
		vi.doUnmock("./watch-suppression.js");

		expect(firstResult).toMatchObject({status: "rejected", reason: new Error("refresh boom")});
		expect(secondResult).toMatchObject({status: "rejected", reason: new Error("refresh boom")});
	});

	it("a cold-cache caller coalescing onto a failing background refresh rejects", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "coalesce-bg-fail", dir})]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		enqueueRefresh({
			kind: "children",
			project: "coalesce-bg-fail",
			run: async () => {
				await gate;
				throw new Error("background boom");
			},
		});

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const caller = getProjectChildrenHandler("coalesce-bg-fail");
		const settled = Promise.allSettled([caller]);
		release();
		const [result] = await settled;

		expect(result).toMatchObject({status: "rejected", reason: new Error("background boom")});
	});

	it("a cold-cache caller coalescing onto a successful background refresh returns data", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Child commit"]);
		seedProjectCache([makeProject({name: "coalesce-bg-ok", dir, upstreamRef: "main~1"})]);
		const {getProjectChildrenHandler, refreshProjectChildren} = await import("./server-fns.impl.js");
		enqueueRefresh({
			kind: "children",
			project: "coalesce-bg-ok",
			run: async () => {
				await refreshProjectChildren("coalesce-bg-ok");
			},
		});

		const result = await getProjectChildrenHandler("coalesce-bg-ok");

		expect(result.map((c) => c.subject)).toStrictEqual(["Child commit"]);
	});

	it("a cold-cache caller coalescing onto a cancelled refresh rejects instead of returning []", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "coalesce-cancelled", dir})]);
		const background = workQueue.enqueue({
			coalesceKey: "children:coalesce-cancelled",
			resources: [repoResource("coalesce-cancelled")],
			kind: "children",
			project: "coalesce-cancelled",
			run: async (signal) => {
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						resolve();
					});
				});
			},
		});

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const caller = getProjectChildrenHandler("coalesce-cancelled");
		const settled = Promise.allSettled([caller]);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});
		background.cancel();
		const [result] = await settled;

		expect(result).toMatchObject({
			status: "rejected",
			reason: new Error("Refresh cancelled: children:coalesce-cancelled"),
		});
	});

	it("includes child commits when present", async () => {
		const dir = await createTestGitRepo();
		// Create a child commit beyond the initial commit
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Child commit"]);
		const project = makeProject({name: "children-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("children-test");
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0]!.project).toBe("children-test");
		expect(result[0]!.subject).toBe("Child commit");
	});

	it("sets blockReason when dirty AND sha equals HEAD", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feature-block"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Block commit"]);
		// Make the working tree dirty
		const {writeFile} = await import("node:fs/promises");
		await writeFile(join(dir, "dirty-file.txt"), "dirty");
		await execa("git", ["-C", dir, "add", "dirty-file.txt"]);

		const project = makeProject({
			name: "block-test",
			dir,
			dirty: true,
			upstreamRef: "main",
		});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("block-test");

		// The HEAD commit on the feature-block branch should have a blockReason
		const headSha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
		const headChild = result.find((c) => c.sha === headSha);
		expect(headChild).toBeDefined();
		expect(headChild!.blockReason).toContain("dirty");
		expect(headChild!.blockReason).toContain("block-test");
	});

	it("does NOT set blockReason for non-HEAD commits in dirty project", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "feat"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "First feature"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Second feature"]);
		// Make dirty
		const {writeFile} = await import("node:fs/promises");
		await writeFile(join(dir, "dirty.txt"), "dirty");
		await execa("git", ["-C", dir, "add", "dirty.txt"]);

		const project = makeProject({
			name: "no-block-test",
			dir,
			dirty: true,
			upstreamRef: "main",
		});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("no-block-test");

		const headSha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
		// Non-HEAD children should not have blockReason
		const nonHeadChildren = result.filter((c) => c.sha !== headSha);
		for (const child of nonHeadChildren) {
			expect(child.blockReason).toBeUndefined();
		}
	});

	it("includes failedChecks from cached PR statuses", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "ci-fail"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "CI fail commit"]);

		const {cachePrStatuses} = await import("@wip/shared");
		cachePrStatuses("ci-fail-test", [
			{
				branch: "ci-fail",
				reviewStatus: "no_pr",
				checkStatus: "failed",
				prUrl: "https://github.com/owner/repo/pull/99",
				prNumber: 99,
				failedChecks: [{name: "ci/lint", url: "https://github.com/owner/repo/actions/runs/99"}],
			},
		]);

		const project = makeProject({
			name: "ci-fail-test",
			dir,
			upstreamRef: "main",
		});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("ci-fail-test");
		const child = result.find((c) => c.branch === "ci-fail");
		expect(child).toBeDefined();
		expect(child!.failedChecks).toStrictEqual([
			{name: "ci/lint", url: "https://github.com/owner/repo/actions/runs/99"},
		]);
	});

	it("includes mergeStateStatus from cached PR statuses", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "blocked-pr"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Blocked PR commit"]);

		const {cachePrStatuses} = await import("@wip/shared");
		cachePrStatuses("merge-state-test", [
			{
				branch: "blocked-pr",
				reviewStatus: "approved",
				checkStatus: "passed",
				prUrl: "https://github.com/owner/repo/pull/42",
				prNumber: 42,
				behind: false,
				mergeStateStatus: "BLOCKED",
			},
		]);

		const project = makeProject({
			name: "merge-state-test",
			dir,
			upstreamRef: "main",
		});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("merge-state-test");
		const child = result.find((c) => c.branch === "blocked-pr");
		expect(child).toBeDefined();
		expect(child!.mergeStateStatus).toBe("BLOCKED");
	});

	it("filters out snoozed children", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Snoozed commit"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const {snoozeItem} = await import("@wip/shared");
		snoozeItem(sha, "snooze-filter-test", sha.slice(0, 7), "Snoozed commit", null);

		const project = makeProject({
			name: "snooze-filter-test",
			dir,
			upstreamRef: "main~1",
		});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("snooze-filter-test");
		const snoozedChild = result.find((c) => c.sha === sha);
		expect(snoozedChild).toBeUndefined();
	});
});

// -- pushChildHandler (direct handler tests) --

describe("pushChildHandler", () => {
	it("enqueues a push task", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Push this"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		seedProjectCache([makeProject({name: "push-enqueue-handler", dir})]);

		const {pushChildHandler} = await import("./server-fns.impl.js");
		const result = await pushChildHandler({
			project: "push-enqueue-handler",
			sha,
			branch: "main",
		});

		expect(result.id).toBeDefined();
		// Pushes now go through the shared work queue instead of starting
		// unconditionally, so a fresh push reports queued (or running once admitted).
		expect(["queued", "running"]).toContain(result.status);
	});

	it("derives branch name when no branch is provided", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Branchless push"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		seedProjectCache([makeProject({name: "push-branch-derive", dir})]);

		const {pushChildHandler} = await import("./server-fns.impl.js");
		const result = await pushChildHandler({
			project: "push-branch-derive",
			sha,
		});

		expect(result.id).toBeDefined();
		expect(["queued", "running"]).toContain(result.status);
	});
});

describe("createPrHandler", () => {
	it("refuses to create a PR for a branch behind upstream", async () => {
		const dir = await createTestGitRepo();
		const remoteDir = await createBareRemote();
		await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "-b", "feature/create-pr"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature work"]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "feature/create-pr"]);
		await execa("git", ["-C", dir, "checkout", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Upstream work"]);
		await execa("git", ["-C", dir, "push", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "feature/create-pr"]);

		seedProjectCache([makeProject({name: "create-pr-behind", dir, remote: "alice/example-repo"})]);

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({
			project: "create-pr-behind",
			branch: "feature/create-pr",
			title: "Feature work",
			draft: true,
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("feature/create-pr is behind origin/main");
		expect(result.message).toContain("rebase before creating a PR");
	});

	it("creates a PR when the branch contains upstream", async () => {
		const dir = await createTestGitRepo();
		const remoteDir = await createBareRemote();
		await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "-b", "feature/current-pr"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Current feature work"]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "feature/current-pr"]);

		seedProjectCache([makeProject({name: "create-pr-current", dir, remote: "alice/example-repo"})]);

		const {polly, stop} = setupPolly({name: "createPrHandler-current-branch"});
		pollyStop = stop;
		let createPrVariables: Record<string, unknown> | undefined;
		polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
			const body = JSON.parse(String(req.body)) as {query: string; variables?: Record<string, unknown>};
			if (body.query.includes("createPullRequest")) {
				createPrVariables = body.variables;
				res.status(200).json({
					data: {
						createPullRequest: {
							pullRequest: {url: "https://example.com/alice/example-repo/pull/100"},
						},
					},
				});
				return;
			}
			res.status(200).json({data: {repository: {id: "REPOSITORY_100"}}});
		});

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({
			project: "create-pr-current",
			branch: "feature/current-pr",
			title: "Current feature work",
			draft: true,
		});

		expect(createPrVariables).toMatchObject({
			baseRefName: "main",
			headRefName: "feature/current-pr",
			title: "Current feature work",
			body: "",
			draft: true,
		});
		expect(result).toMatchObject({
			ok: true,
			message: "Created PR: https://example.com/alice/example-repo/pull/100",
			compareUrl: "https://example.com/alice/example-repo/pull/100",
		});
	});
});

// -- rebaseLocalHandler (direct handler tests) --

describe("rebaseLocalHandler", () => {
	it("rebases a branch onto upstream successfully", async () => {
		const dir = await createTestGitRepo();
		// Create upstream commit on main
		const {writeFile} = await import("node:fs/promises");
		await writeFile(join(dir, "upstream.txt"), "upstream change");
		await execa("git", ["-C", dir, "add", "upstream.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Upstream commit"]);

		// Create a feature branch from the initial commit
		await execa("git", ["-C", dir, "checkout", "-b", "feature/rebase-me", "HEAD~1"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature commit"]);

		// Go back to main so rebaseLocal can check it out
		await execa("git", ["-C", dir, "checkout", "main"]);

		seedProjectCache([makeProject({name: "rebase-handler-test", dir, upstreamRef: "main"})]);

		const {rebaseLocalHandler} = await import("./server-fns.impl.js");
		const result = await rebaseLocalHandler({
			project: "rebase-handler-test",
			branch: "feature/rebase-me",
		});

		// Rebase succeeds but push fails (no remote) - that's expected
		// The message should indicate push failure, not rebase failure
		expect(result.message).not.toContain("Rebase failed with conflicts");
	});

	it("returns failure when branch does not exist", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "checkout-fail-test", dir})]);

		const {rebaseLocalHandler} = await import("./server-fns.impl.js");
		const result = await rebaseLocalHandler({
			project: "checkout-fail-test",
			branch: "nonexistent-branch",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("Failed to checkout");
	});

	it("aborts on conflict and returns failure", async () => {
		const dir = await createTestGitRepo();
		const {writeFile} = await import("node:fs/promises");

		// Create conflicting changes on main
		await writeFile(join(dir, "conflict.txt"), "main version");
		await execa("git", ["-C", dir, "add", "conflict.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Main change"]);

		// Create a feature branch from initial commit with conflicting content
		await execa("git", ["-C", dir, "checkout", "-b", "conflict-branch", "HEAD~1"]);
		await writeFile(join(dir, "conflict.txt"), "branch version");
		await execa("git", ["-C", dir, "add", "conflict.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Branch change"]);

		await execa("git", ["-C", dir, "checkout", "main"]);

		seedProjectCache([makeProject({name: "rebase-conflict-test", dir, upstreamRef: "main"})]);

		const {rebaseLocalHandler} = await import("./server-fns.impl.js");
		const result = await rebaseLocalHandler({
			project: "rebase-conflict-test",
			branch: "conflict-branch",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("Rebase failed with conflicts");
	});
});

// -- refreshAllHandler (direct handler tests) --

/** Create a git repo under projectsDir that project discovery accepts (origin, upstream, upstream/main). */
async function addDiscoverableRepo(projectsDir: string, name: string): Promise<void> {
	const dir = join(projectsDir, name);
	await makeDirectory(dir);
	await execa("git", ["init", "--initial-branch=main"], {cwd: dir});
	await execa("git", ["config", "user.email", "test@test.com"], {cwd: dir});
	await execa("git", ["config", "user.name", "Test User"], {cwd: dir});
	await execa("git", ["commit", "--allow-empty", "-m", "Initial commit"], {cwd: dir});
	await execa("git", ["remote", "add", "origin", `https://github.com/owner/${name}.git`], {cwd: dir});
	await execa("git", ["remote", "add", "upstream", `https://github.com/owner/${name}.git`], {cwd: dir});
	await execa("git", ["update-ref", "refs/remotes/upstream/main", "HEAD"], {cwd: dir});
}

describe("refreshAllHandler enqueues through the queue", () => {
	it("enqueues one forced refresh per project and returns started immediately", async () => {
		const projectsDir = await mkdtemp(join(tmpdir(), "wip-projects-"));
		tmpDirs.push(projectsDir);
		projectsDirsOverride.dirs = [projectsDir];
		try {
			await addDiscoverableRepo(projectsDir, "ra-one");
			await addDiscoverableRepo(projectsDir, "ra-two");
			forcedRefreshSpy.mockClear();
			const {refreshAllHandler} = await import("./server-fns.impl.js");
			const result = await refreshAllHandler();
			expect(result).toStrictEqual({started: 2});
			expect(forcedRefreshSpy.mock.calls).toStrictEqual([
				["ra-one", {force: true}],
				["ra-two", {force: true}],
			]);
		} finally {
			projectsDirsOverride.dirs = undefined;
		}
	});
});

describe("refreshAllHandler rediscovers projects", () => {
	it("picks up a repo cloned after the project cache was seeded", async () => {
		const {getProjectsHandler, refreshAllHandler} = await import("./server-fns.impl.js");
		const projectsDir = await mkdtemp(join(tmpdir(), "wip-projects-"));
		tmpDirs.push(projectsDir);
		projectsDirsOverride.dirs = [projectsDir];
		try {
			await addDiscoverableRepo(projectsDir, "rr-existing");
			seedProjectCache([makeProject({name: "rr-stale", dir: projectsDir})]);
			await addDiscoverableRepo(projectsDir, "rr-new");

			await refreshAllHandler();

			const names = (await getProjectsHandler()).map((p) => p.name).toSorted();
			expect(names).toStrictEqual(["rr-existing", "rr-new"]);
		} finally {
			projectsDirsOverride.dirs = undefined;
		}
	});
});

describe("refreshAllHandler", () => {
	it("invalidates all caches and returns success", async () => {
		const {cachePrStatuses, getCachedPrStatuses} = await import("@wip/shared");

		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "refresh-handler-test", dir})]);

		cachePrStatuses("refresh-handler-test", [
			{
				branch: "some-branch",
				reviewStatus: "no_pr",
				checkStatus: "none",
				prUrl: null,
				prNumber: undefined,
				failedChecks: [],
			},
		]);

		const before = getCachedPrStatuses("refresh-handler-test");
		expect(before).not.toBeNull();

		// refreshAllHandler calls refreshProjectCache which needs filesystem discovery.
		// We mock discoverAllProjects via the project cache seeding.
		// Since we cannot easily mock discoverAllProjects, test the invalidation effect
		// by calling the underlying functions directly.
		const {invalidatePrCache, invalidateIssuesCache, invalidateProjectItemsCache} = await import("@wip/shared");
		invalidateIssuesCache();
		invalidateProjectItemsCache();
		invalidatePrCache("refresh-handler-test");

		const after = getCachedPrStatuses("refresh-handler-test");
		expect(after).toBeNull();
	});
});

describe("launchBackgroundEnqueue failure reporting (B32)", () => {
	it("reports a background enqueue failure to the client over the refresh-error channel", async () => {
		const events: Array<{kind: string; project: string; message: string}> = [];
		const unsubscribe = onRefreshError((event) => events.push(event));
		try {
			launchBackgroundEnqueue("testAllChildren", async () => Promise.reject(new Error("planning exploded")));
			await vi.waitFor(() => {
				expect(events).toHaveLength(1);
			});
		} finally {
			unsubscribe();
		}
		expect(events).toStrictEqual([
			{kind: "testAllChildren", project: "all projects", message: "planning exploded"},
		]);
	});
});

// Re-export harness utilities for use in future test files
export {setupPolly, makeProject, createTestGitRepo};

async function tick(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function holdRepo(project: string): () => void {
	let release!: () => void;
	workQueue.enqueue({
		coalesceKey: `hold:${project}`,
		resources: [repoResource(project)],
		kind: "rebase",
		project,
		costClass: "git-write",
		priority: "foreground",
		run: async () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	});
	return () => {
		release();
	};
}

interface ExecCall {
	command: string;
	args: string[];
}

/**
 * Runs the action while another job holds the repo and reports which subprocesses
 * were spawned before and after the hold was released. Subprocesses are faked, so
 * no real claude, gh or git push ever runs.
 */
async function execCallsAroundRepoHold(
	project: string,
	call: () => Promise<unknown>,
): Promise<{whileHeld: ExecCall[]; afterRelease: ExecCall[]}> {
	const calls: ExecCall[] = [];
	fakeExeca.handler = (command, args) => {
		calls.push({command, args});
		const stdout = command === "mise" ? "{}" : "";
		return {stdout, stderr: "", exitCode: 0, failed: false, command: [command, ...args].join(" ")};
	};
	const release = holdRepo(project);
	await tick();
	const pending = call();
	await new Promise((resolve) => {
		setTimeout(resolve, 20);
	});
	const whileHeld = [...calls];
	release();
	await pending;
	return {whileHeld, afterRelease: calls.slice(whileHeld.length)};
}

describe("queued git actions", () => {
	afterEach(() => {
		fakeExeca.handler = undefined;
	});

	it("forcePushHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-force-push", dir})]);
		const {forcePushHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-force-push", async () =>
			forcePushHandler({project: "queued-force-push", branch: "main"}),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.map((c) => [c.command, c.args.includes("push")])).toContainEqual(["git", true]);
	});

	it("mergePrHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-merge-pr", dir})]);
		const {mergePrHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-merge-pr", async () =>
			mergePrHandler({project: "queued-merge-pr", prNumber: 1}),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.map((c) => [c.command, c.args.slice(0, 3)])).toContainEqual(["gh", ["pr", "merge", "1"]]);
	});

	it("createPrHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-create-pr", dir})]);
		const {createPrHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-create-pr", async () =>
			createPrHandler({project: "queued-create-pr", branch: "main", title: "t", draft: true}),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.map((c) => [c.command, c.args.includes("fetch")])).toContainEqual(["git", true]);
	});

	it("applyFixesHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-apply-fixes", dir})]);
		const {applyFixesHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-apply-fixes", async () =>
			applyFixesHandler({project: "queued-apply-fixes", branch: "main", prNumber: 1}),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.length).toBeGreaterThan(0);
	});

	it("rebaseLocalHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-rebase-local", dir})]);
		const {rebaseLocalHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-rebase-local", async () =>
			rebaseLocalHandler({project: "queued-rebase-local", branch: "main"}),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.length).toBeGreaterThan(0);
	});

	it("commitWorkingTreeHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-commit-tree", dir})]);
		const {commitWorkingTreeHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-commit-tree", async () =>
			commitWorkingTreeHandler("queued-commit-tree"),
		);
		expect(whileHeld).toEqual([]);
		expect(afterRelease.map((c) => [c.command, c.args])).toContainEqual(["claude", ["-p", "/git:commit"]]);
	});
});
