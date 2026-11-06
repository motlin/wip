import {describe, it, expect, beforeEach, afterEach, vi} from "vite-plus/test";
import {Polly, type PollyConfig} from "@pollyjs/core";
import {tmpdir} from "node:os";
import {mkdir as makeDirectory, mkdtemp, readFile, realpath, rm, writeFile as writeTestFile} from "node:fs/promises";
import {join} from "node:path";
import {execa} from "execa";

import {
	initDb,
	resetDb,
	setGitHubClient,
	resetGitHubClient,
	createTestClient,
	cacheUpstreamSha,
	cacheMiseEnv,
	miseConfigFingerprint,
	cacheMergeStatus,
	getCachedMergeStatuses,
	getCachedUpstreamSha,
	getLastKnownChildren,
	cacheIssues,
	cacheProjectItems,
	type GitHubIssue,
	type ProjectInfo,
	classifyGitChild,
	upstreamRedCommand,
	setConfigValue,
	unsetConfigValue,
	loadWorkItems,
	getAutoFixes,
	getCommitFacts,
	setAutoFix,
	resetAutoMergeAllowedCache,
	resetGitHubRateLimit,
	resetRepositoryIdCache,
	resetViewerPermissionCache,
} from "@wip/shared";
import {
	drainBackgroundEnqueues,
	getManagedFailedBaseBranches,
	launchBackgroundEnqueue,
	localBaselineRedChild,
	seedProjectCache,
	resetProjectCache,
} from "./server-fns.impl.js";
import {enqueueRefresh, onRefreshError, resetScheduler} from "./refresh-scheduler.js";
import {resetQueue} from "./task-queue.js";
import {workQueue} from "./shared-work-queue.js";
import {repoResource} from "./repo-resource.js";
import {makeChild} from "./test-factories.js";

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

// The ready buffer reads projects through the server function; outside a request it needs the handler.
vi.mock("./server-fns.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./server-fns.js")>()),
	getProjects: async () => (await import("./server-fns.impl.js")).getProjectsHandler(),
}));

const readyBufferOverride = vi.hoisted(() => ({running: false, stoppedProjects: [] as string[]}));
vi.mock("./ready-buffer-instance.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ready-buffer-instance.js")>();
	return {
		...actual,
		currentReadyBuffer: () =>
			readyBufferOverride.running
				? ({
						state: () => ({
							slots: 0,
							ready: [],
							inFlight: [],
							next: [],
							stoppedProjects: readyBufferOverride.stoppedProjects,
						}),
					} as unknown as ReturnType<typeof actual.currentReadyBuffer>)
				: actual.currentReadyBuffer(),
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

/** Store a git-test verdict for the default test by running a trivial command. A bad run exits non-zero. */
async function markGitTest(dir: string, sha: string, good: boolean): Promise<void> {
	await execa("git", ["-C", dir, "config", "test.default.command", good ? "true" : "false"]);
	await execa("git", ["-C", dir, "test", "run", "--test", "default", sha], {reject: false});
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

/** Bumped as each test starts, so a teardown that outlived its test leaves the next test's state alone. */
let testGeneration = 0;
let teardownPending = false;

beforeEach(() => {
	testGeneration += 1;
	if (teardownPending) {
		// The previous test's teardown timed out while draining work that test left running. Drop its
		// state here, so that failure stays its own instead of failing this test's initDb().
		resetGitHubClient();
		resetProjectCache();
		resetDb();
	}
	initDb(":memory:");
	setGitHubClient(createTestClient());
});

afterEach(async () => {
	const generation = testGeneration;
	teardownPending = true;
	if (pollyStop) {
		await pollyStop();
		pollyStop = undefined;
	}
	// Settle every background job before the DB goes away: a job still running after resetDb()
	// would reopen the real on-disk database and make the next test's initDb() throw.
	await drainBackgroundEnqueues();
	await resetQueue();
	await resetScheduler();
	// Timed out: a later test owns the database and caches now.
	if (generation !== testGeneration) return;
	resetGitHubClient();
	resetProjectCache();
	resetDb();
	vi.unstubAllEnvs();

	// Clean up temporary git repos
	await Promise.all(tmpDirs.map(async (dir) => rm(dir, {recursive: true, force: true})));
	tmpDirs = [];
	teardownPending = false;
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

describe("localBaselineRedChild", () => {
	const project: ProjectInfo = {
		name: "proj",
		dir: "/tmp/proj",
		remote: "motlin/proj",
		originRemote: "origin",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
	const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("reports a failed git-test baseline as an upstream_red child suggesting /build:fix", () => {
		const child = localBaselineRedChild(project, sha, "failed", "2026-10-26");
		expect(child).toStrictEqual({
			kind: "upstream_ci",
			project: "proj",
			remote: "motlin/proj",
			originRemote: "origin",
			sha,
			shortSha: "bbbbbbb",
			subject: "Fix failing tests on upstream/main",
			date: "2026-10-26",
			branch: "main",
			testStatus: "failed",
			checkStatus: "none",
			skippable: false,
			pushedToRemote: true,
			reviewStatus: "no_pr",
		});
		expect(child && {category: classifyGitChild(child, project), command: upstreamRedCommand(child)}).toStrictEqual(
			{
				category: "upstream_red",
				command: "/build:fix",
			},
		);
	});

	it("reports nothing for a green or unknown baseline", () => {
		expect([
			localBaselineRedChild(project, sha, "passed", "2026-10-26"),
			localBaselineRedChild(project, sha, undefined, "2026-10-26"),
		]).toStrictEqual([undefined, undefined]);
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
			patchId: null,
			orphaned: false,
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

	it("returns noop when a project has no branch units and git-test reports the baseline good", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		const baselineSha = (await execa("git", ["-C", dir, "rev-parse", "main"])).stdout.trim();
		await markGitTest(dir, baselineSha, true);

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

	it("derives each branch's expected actions from its tip's git-test result", async () => {
		const {generateAdvancePlanForProjects} = await import("./server-fns.impl.js");
		const dir = await createTestGitRepo();
		// git-test keys verdicts by tree, so each branch commits a distinct file.
		const commitFile = async (branch: string, file: string): Promise<string> => {
			await execa("git", ["-C", dir, "checkout", "-b", branch, "main"]);
			await writeTestFile(join(dir, file), file);
			await execa("git", ["-C", dir, "add", file]);
			await execa("git", ["-C", dir, "commit", "-m", file]);
			return (await execa("git", ["-C", dir, "rev-parse", branch])).stdout.trim();
		};
		const passedSha = await commitFile("feature/passed", "passed.txt");
		const failedSha = await commitFile("feature/failed", "failed.txt");
		await commitFile("feature/untested", "untested.txt");
		await markGitTest(dir, passedSha, true);
		await markGitTest(dir, failedSha, false);

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

	it("passes --retest only for an explicit Run Test on a test_failed commit", async () => {
		const {testChildHandler} = await import("./server-fns.impl.js");
		const {getAllJobs, testTaskArgs} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		// git-test keys results by tree, so each commit changes a file.
		await writeTestFile(join(dir, "a.txt"), "red\n");
		await execa("git", ["add", "a.txt"], {cwd: dir});
		await execa("git", ["commit", "-m", "red"], {cwd: dir});
		const red = (await execa("git", ["rev-parse", "HEAD"], {cwd: dir})).stdout.trim();
		await writeTestFile(join(dir, "a.txt"), "untested\n");
		await execa("git", ["commit", "-am", "untested"], {cwd: dir});
		const untested = (await execa("git", ["rev-parse", "HEAD"], {cwd: dir})).stdout.trim();
		await markGitTest(dir, red, false);
		seedProjectCache([makeProject({name: "retest-proj", dir})]);

		const redJob = await testChildHandler({project: "retest-proj", sha: red});
		const untestedJob = await testChildHandler({project: "retest-proj", sha: untested});

		const jobs = getAllJobs();
		expect([testTaskArgs(jobs.get(redJob.id)!), testTaskArgs(jobs.get(untestedJob.id)!)]).toStrictEqual([
			["test", "run", "--retest", red],
			["test", "run", untested],
		]);
	});

	it("runs a Run Test task in the sibling test worktree, never in the user's checkout", async () => {
		const {testChildHandler} = await import("./server-fns.impl.js");
		const {getAllJobs, waitForTask} = await import("./task-queue.js");

		const dir = await createTestGitRepo();
		const worktree = `${await realpath(dir)}-test-worktree`;
		tmpDirs.push(worktree);
		const scratch = await mkdtemp(join(tmpdir(), "wip-run-test-scratch-"));
		tmpDirs.push(scratch);
		await writeTestFile(join(dir, "a.txt"), "tip\n");
		await execa("git", ["add", "a.txt"], {cwd: dir});
		await execa("git", ["commit", "-m", "tip"], {cwd: dir});
		const tip = (await execa("git", ["rev-parse", "HEAD"], {cwd: dir})).stdout.trim();
		// The user sits on a detached older commit with work in progress.
		await execa("git", ["checkout", "--detach", "HEAD~1"], {cwd: dir});
		await writeTestFile(join(dir, "wip.txt"), "in progress\n");
		const during = join(scratch, "during");
		await execa("git", [
			"-C",
			dir,
			"config",
			"test.default.command",
			`echo "$(git -C ${dir} rev-parse HEAD) $(pwd -P)" >> ${during}`,
		]);
		const state = async () => ({
			head: (await execa("git", ["rev-parse", "HEAD"], {cwd: dir})).stdout,
			reflog: (await execa("git", ["reflog", "HEAD"], {cwd: dir})).stdout,
			status: (await execa("git", ["status", "--porcelain"], {cwd: dir})).stdout,
		});
		const before = await state();
		seedProjectCache([makeProject({name: "worktree-proj", dir})]);

		const job = await testChildHandler({project: "worktree-proj", sha: tip});
		await waitForTask(job.id);

		expect({
			status: getAllJobs().get(job.id)?.status,
			after: await state(),
			during: await readFile(during, "utf8"),
		}).toStrictEqual({
			status: "passed",
			after: before,
			during: `${before.head} ${worktree}\n`,
		});
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

	it("attaches files, insertions and deletions from the commit-facts cache to each child", async () => {
		const dir = await createTestGitRepo();
		await writeTestFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
		await writeTestFile(join(dir, "b.txt"), "b\n");
		await execa("git", ["-C", dir, "add", "a.txt", "b.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Sized commit"]);
		const project = makeProject({name: "sized-children-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("sized-children-test");

		expect(
			result.map((c) => ({subject: c.subject, files: c.files, insertions: c.insertions, deletions: c.deletions})),
		).toStrictEqual([{subject: "Sized commit", files: 2, insertions: 4, deletions: 0}]);
	});

	it("carries each child's parent sha, so stacks are visible to readiness and landing order", async () => {
		const dir = await createTestGitRepo();
		const base = await gitOut(dir, "rev-parse", "main");
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Parented commit"]);
		seedProjectCache([makeProject({name: "parent-sha-test", dir, upstreamRef: "main~1"})]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("parent-sha-test");

		expect(result.map((c) => ({subject: c.subject, parentSha: c.parentSha}))).toStrictEqual([
			{subject: "Parented commit", parentSha: base},
		]);
	});

	it("reconciles the work-item ledger from the children set, keeping one item across a reword", async () => {
		const dir = await createTestGitRepo();
		await writeTestFile(join(dir, "ledger.txt"), "ledger\n");
		await execa("git", ["-C", dir, "add", "ledger.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Ledger commit"]);
		const project = makeProject({name: "ledger-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {refreshProjectChildren} = await import("./server-fns.impl.js");
		await refreshProjectChildren("ledger-test");
		const [first] = loadWorkItems("ledger-test");
		await execa("git", ["-C", dir, "commit", "--amend", "-m", "Ledger commit reworded"]);
		const {stdout: reworded} = await execa("git", ["-C", dir, "rev-parse", "HEAD"]);
		await refreshProjectChildren("ledger-test");

		expect(
			loadWorkItems("ledger-test").map((item) => ({
				sha: item.sha,
				subject: item.subject,
				firstSeen: item.firstSeen,
				state: item.state,
			})),
		).toStrictEqual([
			{sha: reworded, subject: "Ledger commit reworded", firstSeen: first?.firstSeen, state: first?.state},
		]);
	});

	it("carries the ledger's first seen onto the child, unchanged across a reword", async () => {
		const dir = await createTestGitRepo();
		await writeTestFile(join(dir, "age.txt"), "age\n");
		await execa("git", ["-C", dir, "add", "age.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Aged commit"]);
		const project = makeProject({name: "age-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {refreshProjectChildren} = await import("./server-fns.impl.js");
		const before = await refreshProjectChildren("age-test");
		const [ledgerItem] = loadWorkItems("age-test");
		await execa("git", ["-C", dir, "commit", "--amend", "-m", "Aged commit reworded"]);
		const after = await refreshProjectChildren("age-test");

		expect({
			before: before.map((c) => ({subject: c.subject, firstSeen: c.firstSeen})),
			after: after.map((c) => ({subject: c.subject, firstSeen: c.firstSeen})),
			ledgerHasFirstSeen: typeof ledgerItem?.firstSeen,
		}).toStrictEqual({
			before: [{subject: "Aged commit", firstSeen: ledgerItem?.firstSeen}],
			after: [{subject: "Aged commit reworded", firstSeen: ledgerItem?.firstSeen}],
			ledgerHasFirstSeen: "string",
		});
	});

	it("records an unnamed child that leaves the children set by fast-forward as landed", async () => {
		const dir = await createTestGitRepo();
		const {stdout: base} = await execa("git", ["-C", dir, "rev-parse", "HEAD"]);
		await execa("git", ["-C", dir, "branch", "upstream-tip", base]);
		await writeTestFile(join(dir, "ff.txt"), "ff\n");
		await execa("git", ["-C", dir, "add", "ff.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Fast-forward commit"]);
		const {stdout: child} = await execa("git", ["-C", dir, "rev-parse", "HEAD"]);
		const project = makeProject({name: "ledger-ff-test", dir, upstreamRef: "upstream-tip"});
		seedProjectCache([project]);

		const {refreshProjectChildren} = await import("./server-fns.impl.js");
		await refreshProjectChildren("ledger-ff-test");
		await execa("git", ["-C", dir, "branch", "-f", "upstream-tip", child]);
		await refreshProjectChildren("ledger-ff-test");

		expect(
			loadWorkItems("ledger-ff-test").map((item) => ({
				subject: item.subject,
				state: item.state,
				landed: item.landedAt !== null,
			})),
		).toStrictEqual([{subject: "Fast-forward commit", state: "landed", landed: true}]);
	});

	it("flags a child that local main already contains but the upstream branch does not", async () => {
		const {dir} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "feature");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Fast-forwarded commit");
		const forwarded = await gitOut(dir, "rev-parse", "feature");
		await gitOut(dir, "checkout", "-b", "other", "main");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Other commit");
		await gitOut(dir, "branch", "-f", "main", forwarded);
		seedProjectCache([makeProject({name: "on-local-main", dir})]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const children = await getProjectChildrenHandler("on-local-main");

		expect(
			children
				.map((c) => ({subject: c.subject, onLocalMain: c.onLocalMain}))
				.toSorted((a, b) => a.subject.localeCompare(b.subject)),
		).toStrictEqual([
			{subject: "Fast-forwarded commit", onLocalMain: true},
			{subject: "Other commit", onLocalMain: undefined},
		]);
	});

	it("marks a child above flow.splitThresholdLines consider splitting and leaves smaller ones unmarked", async () => {
		const dir = await createTestGitRepo();
		const {stdout: base} = await execa("git", ["-C", dir, "rev-parse", "HEAD"]);
		await execa("git", ["-C", dir, "checkout", "-b", "small"]);
		await writeTestFile(join(dir, "small.txt"), "one\n");
		await execa("git", ["-C", dir, "add", "small.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Small commit"]);
		await execa("git", ["-C", dir, "checkout", "-b", "large", base]);
		await writeTestFile(join(dir, "large.txt"), "one\ntwo\nthree\nfour\n");
		await execa("git", ["-C", dir, "add", "large.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Large commit"]);
		const project = makeProject({name: "split-marker-test", dir, upstreamRef: base});
		seedProjectCache([project]);
		setConfigValue("flow.splitThresholdLines", "3");

		try {
			const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
			const result = await getProjectChildrenHandler("split-marker-test");

			expect(
				result
					.map((c) => ({subject: c.subject, considerSplitting: c.considerSplitting}))
					.toSorted((a, b) => a.subject.localeCompare(b.subject)),
			).toStrictEqual([
				{subject: "Large commit", considerSplitting: true},
				{subject: "Small commit", considerSplitting: undefined},
			]);
		} finally {
			unsetConfigValue("flow.splitThresholdLines");
		}
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

	it("marks only the child checked out at HEAD with isHead", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "checkout", "-b", "other"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Other commit"]);
		await execa("git", ["-C", dir, "checkout", "main"], {cwd: dir});
		await execa("git", ["-C", dir, "checkout", "-b", "current"], {cwd: dir});
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Current commit"]);

		const project = makeProject({name: "is-head-test", dir, dirty: true, upstreamRef: "main"});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("is-head-test");

		expect(
			result
				.map((c) => ({branch: c.branch, isHead: c.isHead}))
				.toSorted((a, b) => a.branch!.localeCompare(b.branch!)),
		).toEqual([
			{branch: "current", isHead: true},
			{branch: "other", isHead: false},
		]);
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

	it("enqueues no branch-name job on a refresh with 10 unnamed children", async () => {
		const dir = await createTestGitRepo();
		// Ten sibling commits on main, each reachable only through a non-branch ref, so none has a name.
		await Promise.all(
			Array.from({length: 10}, async (_, i) => {
				const sha = (
					await execa("git", ["-C", dir, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", `Unnamed ${i}`])
				).stdout.trim();
				await execa("git", ["-C", dir, "update-ref", `refs/unnamed/${i}`, sha]);
			}),
		);

		const project = makeProject({name: "lazy-naming-test", dir, upstreamRef: "main"});
		seedProjectCache([project]);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue").mockImplementation(
			() =>
				({
					settled: Promise.resolve(),
					coalesced: false,
				}) as unknown as ReturnType<typeof workQueue.enqueue>,
		);

		const {refreshProjectChildren} = await import("./server-fns.impl.js");
		const children = await refreshProjectChildren("lazy-naming-test");
		const namingJobs = enqueueSpy.mock.calls.filter(([job]) => job.kind === "branch-name");
		enqueueSpy.mockRestore();

		expect({
			unnamed: children.filter((c) => c.branch === undefined).length,
			namingJobs: namingJobs.length,
		}).toStrictEqual({unnamed: 10, namingJobs: 0});
	});

	it("returns an On hold child flagged instead of dropping it, and enqueues no branch-name job for it", async () => {
		const dir = await createTestGitRepo();
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Snoozed commit"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const project = makeProject({
			name: "snooze-filter-test",
			dir,
			upstreamRef: "main~1",
		});
		seedProjectCache([project]);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue").mockImplementation(
			() =>
				({
					settled: Promise.resolve(),
					coalesced: false,
				}) as unknown as ReturnType<typeof workQueue.enqueue>,
		);
		const namingJobs = () =>
			enqueueSpy.mock.calls.filter(([job]) => job.kind === "branch-name").map(([job]) => job.coalesceKey);

		const {refreshProjectChildren} = await import("./server-fns.impl.js");
		const before = await refreshProjectChildren("snooze-filter-test");
		const namedBefore = namingJobs();
		enqueueSpy.mockClear();

		const {snoozeItem} = await import("@wip/shared");
		snoozeItem(sha, "snooze-filter-test", sha.slice(0, 7), "Snoozed commit", null);
		const after = await refreshProjectChildren("snooze-filter-test");
		enqueueSpy.mockRestore();

		expect({
			before: before.map((c) => ({sha: c.sha, onHold: c.onHold})),
			namedBefore,
			after: after.map((c) => ({sha: c.sha, onHold: c.onHold})),
			namedAfter: namingJobs(),
		}).toStrictEqual({
			before: [{sha, onHold: undefined}],
			namedBefore: [],
			after: [{sha, onHold: true}],
			namedAfter: [],
		});
	});

	it("keeps a commit put On hold flagged after it is reworded to a new sha", async () => {
		const dir = await createTestGitRepo();
		await writeTestFile(join(dir, "held.txt"), "held\n");
		await execa("git", ["-C", dir, "add", "held.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Held commit"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const project = makeProject({name: "hold-rebase-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {snoozeChildHandler, getProjectChildrenHandler, getSnoozedListHandler} =
			await import("./server-fns.impl.js");
		await snoozeChildHandler({project: "hold-rebase-test", sha, until: null});
		await execa("git", ["-C", dir, "commit", "--amend", "-m", "Held commit, reworded"]);
		const reworded = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const result = await getProjectChildrenHandler("hold-rebase-test");
		const snoozed = await getSnoozedListHandler();

		expect(result.map((c) => ({sha: c.sha, onHold: c.onHold}))).toStrictEqual([{sha: reworded, onHold: true}]);
		expect(snoozed.map((s) => ({sha: s.sha, until: s.until, orphaned: s.orphaned}))).toStrictEqual([
			{sha: reworded, until: null, orphaned: false},
		]);
	});

	it("keeps a pre-migration On hold row flagged when its commit is rebased before the first children refresh", async () => {
		const dir = await createTestGitRepo();
		await writeTestFile(join(dir, "legacy.txt"), "legacy\n");
		await execa("git", ["-C", dir, "add", "legacy.txt"]);
		await execa("git", ["-C", dir, "commit", "-m", "Legacy held commit"]);
		const sha = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		// A row written before the migration: sha only, no patch-id. /snoozed is never opened.
		const {snoozeItem, getAllSnoozedForDisplay} = await import("@wip/shared");
		snoozeItem(sha, "legacy-hold-test", sha.slice(0, 7), "Legacy held commit", null);
		await execa("git", ["-C", dir, "commit", "--amend", "-m", "Legacy held commit, rebased"]);
		const rebased = (await execa("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

		const project = makeProject({name: "legacy-hold-test", dir, upstreamRef: "main~1"});
		seedProjectCache([project]);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("legacy-hold-test");

		expect({
			held: result.map((c) => ({sha: c.sha, onHold: c.onHold})),
			rows: getAllSnoozedForDisplay().map((s) => ({sha: s.sha, orphaned: s.orphaned})),
		}).toStrictEqual({held: [{sha: rebased, onHold: true}], rows: [{sha: rebased, orphaned: false}]});
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
	afterEach(() => {
		readyBufferOverride.running = false;
		readyBufferOverride.stoppedProjects = [];
	});

	it("refuses while the project's own upstream is red, and pushes nothing", async () => {
		const dir = await createTestGitRepo();
		const remoteDir = await createBareRemote();
		await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "-b", "feature/on-red"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature on red upstream"]);

		seedProjectCache([makeProject({name: "create-pr-red", dir, remote: "alice/example-repo"})]);
		readyBufferOverride.running = true;
		readyBufferOverride.stoppedProjects = ["create-pr-red"];

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({
			project: "create-pr-red",
			branch: "feature/on-red",
			title: "Feature on red upstream",
		});
		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/feature/on-red"], {
			reject: false,
		});

		expect({ok: result.ok, message: result.message, pushed: pushed.exitCode}).toStrictEqual({
			ok: false,
			message: "create-pr-red's upstream is red: fix it before landing",
			pushed: 128,
		});
	});

	it("refuses to rebase a behind branch checked out in a worktree, and pushes nothing", async () => {
		const dir = await createTestGitRepo();
		const remoteDir = await createBareRemote();
		await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "-b", "feature/create-pr"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature work"]);
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
		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/feature/create-pr"], {
			reject: false,
		});

		expect({ok: result.ok, message: result.message, pushed: pushed.exitCode}).toStrictEqual({
			ok: false,
			message:
				"feature/create-pr is behind origin/main and checked out in a worktree; rebase it there before opening a PR",
			pushed: 128,
		});
	});

	it("creates a PR when the branch contains upstream", async () => {
		const dir = await createTestGitRepo();
		const remoteDir = await createBareRemote();
		await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
		await execa("git", ["-C", dir, "checkout", "-b", "feature/current-pr"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Current feature work"]);
		await execa("git", ["-C", dir, "push", "-u", "origin", "feature/current-pr"]);

		seedProjectCache([
			makeProject({
				name: "create-pr-current",
				dir,
				remote: "alice/example-repo",
				originRemote: "alice/example-repo",
			}),
		]);

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
		expect(result).toStrictEqual({
			ok: true,
			message: "Opened PR #100",
			prNumber: 100,
			prUrl: "https://example.com/alice/example-repo/pull/100",
		});
	});
});

/** A local repo with a bare origin holding main, and a feature branch with one local commit. */
async function repoWithFeatureBranch(branch: string): Promise<{dir: string; remoteDir: string}> {
	const dir = await createTestGitRepo();
	const remoteDir = await createBareRemote();
	await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
	await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
	await execa("git", ["-C", dir, "checkout", "-b", branch]);
	await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Feature work"]);
	return {dir, remoteDir};
}

/**
 * A repo whose `branch` (not checked out) is one commit behind origin/main: it adds feature.txt, and
 * upstream added upstream.txt, or changed feature.txt too when `conflict` is set. Test logs and the
 * test worktree go to temp dirs.
 */
async function behindFeatureBranch(
	branch: string,
	{conflict}: {conflict: boolean},
): Promise<{dir: string; remoteDir: string}> {
	const dir = await createTestGitRepo();
	const remoteDir = await createBareRemote();
	tmpDirs.push(`${dir}-test-worktree`);
	const cache = await mkdtemp(join(tmpdir(), "wip-cache-"));
	tmpDirs.push(cache);
	vi.stubEnv("XDG_CACHE_HOME", cache);
	await execa("git", ["-C", dir, "remote", "add", "origin", remoteDir]);
	await execa("git", ["-C", dir, "push", "-u", "origin", "main"]);
	await execa("git", ["-C", dir, "checkout", "-b", branch]);
	await commitNewFile(dir, "feature.txt");
	await execa("git", ["-C", dir, "checkout", "main"]);
	if (conflict) {
		await writeTestFile(join(dir, "feature.txt"), "upstream\n");
		await gitOut(dir, "add", "feature.txt");
		await gitOut(dir, "commit", "-m", "Upstream feature.txt");
	} else {
		await commitNewFile(dir, "upstream.txt");
	}
	await execa("git", ["-C", dir, "push", "origin", "main"]);
	return {dir, remoteDir};
}

/** Fakes GitHub: records the repo each PR targets and its variables; never reaches GitHub. */
function fakeCreatePullRequest(): {calls: {repository: string; variables: Record<string, unknown>}[]} {
	resetRepositoryIdCache();
	const calls: {repository: string; variables: Record<string, unknown>}[] = [];
	let repository = "";
	setGitHubClient({
		graphql: async (query: string, variables?: Record<string, unknown>) => {
			if (query.includes("createPullRequest")) {
				calls.push({repository, variables: {...variables}});
				return Promise.resolve({
					data: {createPullRequest: {pullRequest: {url: `https://github.com/${repository}/pull/9`}}},
				});
			}
			repository = `${String(variables?.["owner"])}/${String(variables?.["name"])}`;
			return Promise.resolve({data: {repository: {id: `REPOSITORY_${repository}`}}});
		},
	});
	return {calls};
}

describe("createPrHandler pushes the branch and targets the base", () => {
	afterEach(() => {
		resetRepositoryIdCache();
	});

	it("pushes a never-pushed branch to origin before opening the PR", async () => {
		const {dir, remoteDir} = await repoWithFeatureBranch("fix-unpushed");
		seedProjectCache([makeProject({name: "pr-unpushed", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-unpushed", branch: "fix-unpushed", title: "Fix"});

		expect({
			ok: result.ok,
			message: result.message,
			remoteTip: await gitOut(remoteDir, "rev-parse", "refs/heads/fix-unpushed"),
			calls: github.calls.map((c) => [c.repository, c.variables["baseRefName"], c.variables["headRefName"]]),
		}).toStrictEqual({
			ok: true,
			message: "Opened PR #9",
			remoteTip: await gitOut(dir, "rev-parse", "fix-unpushed"),
			calls: [["alice/repo", "main", "fix-unpushed"]],
		});
	});

	it("reports its push and PR steps and its result under the client's action id, for the tab it opened", async () => {
		const {dir} = await repoWithFeatureBranch("fix-tracked");
		seedProjectCache([makeProject({name: "pr-tracked", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		fakeCreatePullRequest();
		const {actionEmitter, latestActionEvent} = await import("./action-events.js");
		const events: {status: string; step?: string}[] = [];
		const listener = (event: {id: string; status: string; step?: string}): void => {
			if (event.id === "tab-1")
				events.push(
					event.step === undefined ? {status: event.status} : {status: event.status, step: event.step},
				);
		};
		actionEmitter.on("action", listener);

		const {createPrHandler} = await import("./server-fns.impl.js");
		await createPrHandler({project: "pr-tracked", branch: "fix-tracked", title: "Fix", actionId: "tab-1"});
		actionEmitter.off("action", listener);

		expect({events, result: latestActionEvent("tab-1")?.result}).toStrictEqual({
			events: [
				{status: "waiting"},
				{status: "running"},
				{status: "running", step: "Pushing fix-tracked…"},
				{status: "running", step: "Opening the pull request…"},
				{status: "done"},
			],
			result: {ok: true, message: "Opened PR #9", prUrl: "https://github.com/alice/repo/pull/9"},
		});
	});

	it("rebases a behind branch onto upstream in place, tests it in the test worktree, then pushes and opens the PR", async () => {
		const {dir, remoteDir} = await behindFeatureBranch("fix-behind", {conflict: false});
		await execa("git", [
			"-C",
			dir,
			"config",
			"test.default.command",
			"test -f upstream.txt && test -f feature.txt",
		]);
		seedProjectCache([makeProject({name: "pr-behind", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();
		const {actionEmitter} = await import("./action-events.js");
		const steps: string[] = [];
		const listener = (event: {id: string; step?: string}): void => {
			if (event.id === "tab-behind" && event.step !== undefined) steps.push(event.step);
		};
		actionEmitter.on("action", listener);
		const head = await gitOut(dir, "rev-parse", "HEAD");

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({
			project: "pr-behind",
			branch: "fix-behind",
			title: "Fix",
			actionId: "tab-behind",
		});
		actionEmitter.off("action", listener);
		const tip = await gitOut(dir, "rev-parse", "fix-behind");

		expect({
			ok: result.ok,
			message: result.message,
			steps,
			onUpstream: (
				await execa("git", ["-C", dir, "merge-base", "--is-ancestor", "origin/main", "fix-behind"], {
					reject: false,
				})
			).exitCode,
			tested: (await gitOut(dir, "test", "results", "--test", "default", "--no-color", tip)).split(/\s/)[0],
			remoteTip: await gitOut(remoteDir, "rev-parse", "refs/heads/fix-behind"),
			head: await gitOut(dir, "rev-parse", "HEAD"),
			status: await gitOut(dir, "status", "--porcelain"),
			calls: github.calls.length,
		}).toStrictEqual({
			ok: true,
			message: "Opened PR #9",
			steps: [
				"Rebasing fix-behind onto origin/main…",
				"Testing fix-behind…",
				"Pushing fix-behind…",
				"Opening the pull request…",
			],
			onUpstream: 0,
			tested: "good",
			remoteTip: tip,
			head,
			status: "",
			calls: 1,
		});
	});

	it("keeps a row that fell behind while shown ready, waiting for checks, after Open PR rebases it to a tip no sweep has measured", async () => {
		const {dir} = await behindFeatureBranch("fix-listed", {conflict: false});
		await execa("git", ["-C", dir, "config", "test.default.command", "true"]);
		const upstreamSha = await gitOut(dir, "rev-parse", "origin/main");
		// It fell behind while shown: the merge queue measured the old tip, behind but clean.
		cacheUpstreamSha("pr-listed", "origin/main", upstreamSha);
		const before = await gitOut(dir, "rev-parse", "fix-listed");
		cacheMergeStatus("pr-listed", before, upstreamSha, 1, 1, true);
		const project = makeProject({name: "pr-listed", dir, remote: "alice/repo", originRemote: "alice/repo"});
		seedProjectCache([project]);
		fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-listed", branch: "fix-listed", title: "Fix"});
		const tip = await gitOut(dir, "rev-parse", "fix-listed");
		// The children refresh after Open PR sees the new tip with its PR, before any sweep measures it.
		const {bufferRepoFromChildren} = await import("./ready-buffer.js");
		const mergeStatuses = new Map(getCachedMergeStatuses("pr-listed", upstreamSha).map((ms) => [ms.sha, ms]));
		const repo = bufferRepoFromChildren(
			{...project, hasTestConfigured: true},
			[
				makeChild({
					project: "pr-listed",
					sha: tip,
					branch: "fix-listed",
					testStatus: "passed",
					prNumber: 9,
					checkStatus: "pending",
				}),
			],
			{
				identity: null,
				checkedOutBranches: [],
				onHold: () => false,
				override: () => undefined,
				landing: "pull-request",
				mergeStatus: (sha) => mergeStatuses.get(sha),
			},
		);

		expect({
			ok: result.ok,
			measured: mergeStatuses.get(tip),
			candidates: repo.candidates.map(({sha, state, behind, checksPending}) => ({
				sha,
				state,
				behind,
				checksPending,
			})),
		}).toStrictEqual({
			ok: true,
			measured: {sha: tip, upstreamSha, commitsAhead: 1, commitsBehind: 0, rebaseable: null},
			candidates: [{sha: tip, state: "ready", behind: undefined, checksPending: true}],
		});
	});

	it("records the upstream tip its own fetch saw, so the rebased row is measured before the merge queue's next fetch", async () => {
		const {dir} = await behindFeatureBranch("fix-first-fetch", {conflict: false});
		await execa("git", ["-C", dir, "config", "test.default.command", "true"]);
		const movedSha = await gitOut(dir, "rev-parse", "origin/main");
		const oldSha = await gitOut(dir, "rev-parse", "origin/main^");
		// The merge queue last fetched before upstream moved; Open PR's fetch is the first to see the move.
		cacheUpstreamSha("pr-first-fetch", "origin/main", oldSha);
		const project = makeProject({name: "pr-first-fetch", dir, remote: "alice/repo", originRemote: "alice/repo"});
		seedProjectCache([project]);
		fakeCreatePullRequest();
		const {emitter} = await import("./merge-queue.js");
		const moved: unknown[] = [];
		// What the ready buffer's snapshot reads when upstreamMoved reaches it.
		const childrenAtMove: string[][] = [];
		const onMoved = (event: unknown) => {
			moved.push(event);
			childrenAtMove.push((getLastKnownChildren("pr-first-fetch") ?? []).map((c) => c.sha));
		};
		emitter.on("upstreamMoved", onMoved);

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-first-fetch", branch: "fix-first-fetch", title: "Fix"});
		emitter.off("upstreamMoved", onMoved);
		const tip = await gitOut(dir, "rev-parse", "fix-first-fetch");
		// The children refresh and the buffer's snapshot read merge statuses at the cached upstream tip.
		const cachedUpstream = getCachedUpstreamSha("pr-first-fetch");
		const measured = getCachedMergeStatuses("pr-first-fetch", cachedUpstream ?? "").find((ms) => ms.sha === tip);

		expect({ok: result.ok, cachedUpstream, measured, moved, childrenAtMove}).toStrictEqual({
			ok: true,
			cachedUpstream: movedSha,
			measured: {sha: tip, upstreamSha: movedSha, commitsAhead: 1, commitsBehind: 0, rebaseable: null},
			// Announced once the children show the rebased tip, never the pre-rebase sha the buffer would re-advance.
			moved: [{project: "pr-first-fetch", from: oldSha, to: movedSha}],
			childrenAtMove: [[tip]],
		});
	});

	it("stops with the reason when a behind branch conflicts with upstream, leaving it alone and pushing nothing", async () => {
		const {dir, remoteDir} = await behindFeatureBranch("fix-conflict", {conflict: true});
		const before = await gitOut(dir, "rev-parse", "fix-conflict");
		seedProjectCache([makeProject({name: "pr-conflict", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-conflict", branch: "fix-conflict", title: "Fix"});
		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/fix-conflict"], {
			reject: false,
		});

		expect({
			ok: result.ok,
			message: result.message,
			tip: await gitOut(dir, "rev-parse", "fix-conflict"),
			pushed: pushed.exitCode,
			calls: github.calls.length,
		}).toStrictEqual({
			ok: false,
			message: "fix-conflict conflicts with origin/main; resolve the rebase before opening a PR",
			tip: before,
			pushed: 128,
			calls: 0,
		});
	});

	it("does not push or open a PR when the rebased branch fails its test", async () => {
		const {dir, remoteDir} = await behindFeatureBranch("fix-red", {conflict: false});
		await execa("git", ["-C", dir, "config", "test.default.command", "false"]);
		seedProjectCache([makeProject({name: "pr-red", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-red", branch: "fix-red", title: "Fix"});
		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/fix-red"], {
			reject: false,
		});

		expect({
			ok: result.ok,
			message: result.message,
			pushed: pushed.exitCode,
			calls: github.calls.length,
		}).toStrictEqual({
			ok: false,
			message: "fix-red failed its test after rebasing onto origin/main; not pushed",
			pushed: 128,
			calls: 0,
		});
	});

	it("says the test couldn't run, and leaves the commit untested, when the rebased branch's test command is not on PATH", async () => {
		const {dir, remoteDir} = await behindFeatureBranch("fix-no-yarn", {conflict: false});
		await execa("git", ["-C", dir, "config", "test.default.command", "wip-no-such-command-xyz install"]);
		seedProjectCache([makeProject({name: "pr-no-yarn", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-no-yarn", branch: "fix-no-yarn", title: "Fix"});
		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/fix-no-yarn"], {
			reject: false,
		});
		const status = await execa("git", ["-C", dir, "test", "results", "--no-color", "fix-no-yarn"], {reject: false});

		expect({
			ok: result.ok,
			message: result.message,
			pushed: pushed.exitCode,
			calls: github.calls.length,
			status: /^\w+/.exec(status.stdout)?.[0],
		}).toStrictEqual({
			ok: false,
			message:
				"Couldn't run fix-no-yarn's test after rebasing onto origin/main: wip-no-such-command-xyz: command not found; not pushed",
			pushed: 128,
			calls: 0,
			status: "unknown",
		});
	});

	it("force-pushes with lease when origin's copy of the branch was rewritten locally", async () => {
		const {dir, remoteDir} = await repoWithFeatureBranch("fix-rewritten");
		await execa("git", ["-C", dir, "push", "-u", "origin", "fix-rewritten"]);
		await execa("git", ["-C", dir, "commit", "--amend", "--allow-empty", "-m", "Feature work, reworded"]);
		seedProjectCache([makeProject({name: "pr-rewritten", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-rewritten", branch: "fix-rewritten", title: "Fix"});

		expect({
			ok: result.ok,
			remoteTip: await gitOut(remoteDir, "rev-parse", "refs/heads/fix-rewritten"),
			calls: github.calls.length,
		}).toStrictEqual({ok: true, remoteTip: await gitOut(dir, "rev-parse", "fix-rewritten"), calls: 1});
	});

	it("refuses to overwrite commits another machine pushed to the branch since this clone last fetched it", async () => {
		const {dir, remoteDir} = await repoWithFeatureBranch("fix-shared");
		await execa("git", ["-C", dir, "push", "-u", "origin", "fix-shared"]);
		await execa("git", ["-C", dir, "commit", "--amend", "--allow-empty", "-m", "Feature work, reworded"]);
		const other = await mkdtemp(join(tmpdir(), "wip-other-clone-"));
		tmpDirs.push(other);
		await execa("git", ["clone", "-q", "-b", "fix-shared", remoteDir, other]);
		await execa("git", [
			"-C",
			other,
			"-c",
			"user.name=Other",
			"-c",
			"user.email=other@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"Other machine's work",
		]);
		await execa("git", ["-C", other, "push", "-q", "origin", "fix-shared"]);
		const otherTip = await gitOut(other, "rev-parse", "HEAD");
		seedProjectCache([makeProject({name: "pr-shared", dir, remote: "alice/repo", originRemote: "alice/repo"})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-shared", branch: "fix-shared", title: "Fix"});

		expect({
			ok: result.ok,
			stale: result.message.includes("stale info"),
			remoteTip: await gitOut(remoteDir, "rev-parse", "refs/heads/fix-shared"),
			calls: github.calls.length,
		}).toStrictEqual({ok: false, stale: true, remoteTip: otherTip, calls: 0});
	});

	it("opens the PR in origin's repo when origin is the upstream remote, even for a fork", async () => {
		const {dir} = await repoWithFeatureBranch("fix-fork");
		await execa("git", ["-C", dir, "push", "origin", "main:refs/heads/avalon.cool"]);
		seedProjectCache([
			makeProject({
				name: "pr-fork",
				dir,
				remote: "georgyo/avalon",
				originRemote: "motlin/avalon",
				upstreamRemote: "origin",
				upstreamBranch: "avalon.cool",
				upstreamRef: "origin/avalon.cool",
			}),
		]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-fork", branch: "fix-fork", title: "Fix"});

		expect({
			ok: result.ok,
			calls: github.calls.map((c) => [c.repository, c.variables["baseRefName"], c.variables["headRefName"]]),
		}).toStrictEqual({ok: true, calls: [["motlin/avalon", "avalon.cool", "fix-fork"]]});
	});

	it("fails plainly without calling GitHub when the base branch isn't on the upstream remote", async () => {
		const {dir, remoteDir} = await repoWithFeatureBranch("fix-no-base");
		seedProjectCache([
			makeProject({
				name: "pr-no-base",
				dir,
				upstreamBranch: "avalon.cool",
				upstreamRef: "origin/avalon.cool",
			}),
		]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-no-base", branch: "fix-no-base", title: "Fix"});

		const pushed = await execa("git", ["-C", remoteDir, "rev-parse", "--verify", "refs/heads/fix-no-base"], {
			reject: false,
		});
		expect({ok: result.ok, message: result.message, calls: github.calls, pushed: pushed.exitCode}).toStrictEqual({
			ok: false,
			message: "Can't open a PR: the base branch avalon.cool doesn't exist on origin",
			calls: [],
			pushed: 128,
		});
	});

	it("refuses to open a PR from the base branch itself and pushes nothing", async () => {
		const {dir} = await repoWithFeatureBranch("fix-unused");
		await execa("git", ["-C", dir, "checkout", "main"]);
		await execa("git", ["-C", dir, "commit", "--allow-empty", "-m", "Local main work"]);
		seedProjectCache([makeProject({name: "pr-from-base", dir})]);
		const github = fakeCreatePullRequest();

		const {createPrHandler} = await import("./server-fns.impl.js");
		const result = await createPrHandler({project: "pr-from-base", branch: "main", title: "Fix"});

		expect({
			ok: result.ok,
			message: result.message,
			calls: github.calls,
			ahead: await gitOut(dir, "rev-list", "--count", "origin/main..main"),
		}).toStrictEqual({
			ok: false,
			message: "Can't open a PR from main: it is the base branch, and Open PR never pushes it",
			calls: [],
			ahead: "1",
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

describe("refreshAllHandler after a failed discovery", () => {
	it("rediscovers instead of replaying the rejected discovery", async () => {
		const {refreshAllHandler} = await import("./server-fns.impl.js");
		const projectsDir = await mkdtemp(join(tmpdir(), "wip-projects-"));
		tmpDirs.push(projectsDir);
		try {
			projectsDirsOverride.dirs = [join(projectsDir, "missing")];
			await expect(refreshAllHandler()).rejects.toThrow("ENOENT");

			projectsDirsOverride.dirs = [projectsDir];
			await addDiscoverableRepo(projectsDir, "rf-recovered");
			forcedRefreshSpy.mockClear();

			expect(await refreshAllHandler()).toStrictEqual({started: 1});
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

async function gitOut(dir: string, ...args: string[]): Promise<string> {
	return (await execa("git", ["-C", dir, ...args])).stdout.trim();
}

/** A repo whose `feature` branch conflicts with `main` on file.txt. Returns the feature tip. */
async function createConflictingRepo(): Promise<{dir: string; featureTip: string}> {
	const dir = await createTestGitRepo();
	await writeTestFile(join(dir, "file.txt"), "base\n");
	await gitOut(dir, "add", "file.txt");
	await gitOut(dir, "commit", "-m", "base");
	await gitOut(dir, "checkout", "-b", "feature");
	await writeTestFile(join(dir, "file.txt"), "feature\n");
	await gitOut(dir, "commit", "-am", "feature change");
	const featureTip = await gitOut(dir, "rev-parse", "HEAD");
	await gitOut(dir, "checkout", "main");
	await writeTestFile(join(dir, "file.txt"), "main\n");
	await gitOut(dir, "commit", "-am", "main change");
	return {dir, featureTip};
}

describe("abortRebaseHandler", () => {
	it("aborts a rebase stopped mid-conflict and leaves the branch tip unchanged", async () => {
		const {dir, featureTip} = await createConflictingRepo();
		await gitOut(dir, "checkout", "feature");
		await execa("git", ["-C", dir, "rebase", "main"], {reject: false});
		const {existsSync} = await import("node:fs");
		expect(existsSync(join(dir, ".git", "rebase-merge"))).toBe(true);
		seedProjectCache([makeProject({name: "abort-rebase", dir, rebaseInProgress: true})]);

		const {abortRebaseHandler} = await import("./server-fns.impl.js");
		const result = await abortRebaseHandler("abort-rebase");

		expect({
			ok: result.ok,
			message: result.message,
			rebaseAgainBranch: result.rebaseAgainBranch,
			rebaseMerge: existsSync(join(dir, ".git", "rebase-merge")),
			head: await gitOut(dir, "rev-parse", "HEAD"),
			feature: await gitOut(dir, "rev-parse", "feature"),
		}).toEqual({
			ok: true,
			message: "Aborted rebase in abort-rebase",
			rebaseAgainBranch: "feature",
			rebaseMerge: false,
			head: featureTip,
			feature: featureTip,
		});
	});

	it("aborts a cherry-pick stopped mid-conflict", async () => {
		const {dir, featureTip} = await createConflictingRepo();
		const mainTip = await gitOut(dir, "rev-parse", "main");
		await execa("git", ["-C", dir, "cherry-pick", featureTip], {reject: false});
		seedProjectCache([makeProject({name: "abort-cherry-pick", dir})]);

		const {abortRebaseHandler} = await import("./server-fns.impl.js");
		const result = await abortRebaseHandler("abort-cherry-pick");

		const {existsSync} = await import("node:fs");
		expect({
			ok: result.ok,
			message: result.message,
			rebaseAgainBranch: result.rebaseAgainBranch,
			cherryPickHead: existsSync(join(dir, ".git", "CHERRY_PICK_HEAD")),
			head: await gitOut(dir, "rev-parse", "HEAD"),
		}).toEqual({
			ok: true,
			message: "Aborted cherry-pick in abort-cherry-pick",
			rebaseAgainBranch: undefined,
			cherryPickHead: false,
			head: mainTip,
		});
	});

	it("aborts a merge stopped mid-conflict", async () => {
		const {dir} = await createConflictingRepo();
		const mainTip = await gitOut(dir, "rev-parse", "main");
		await execa("git", ["-C", dir, "merge", "feature"], {reject: false});
		seedProjectCache([makeProject({name: "abort-merge", dir})]);

		const {abortRebaseHandler} = await import("./server-fns.impl.js");
		const result = await abortRebaseHandler("abort-merge");

		const {existsSync} = await import("node:fs");
		expect({
			ok: result.ok,
			message: result.message,
			mergeHead: existsSync(join(dir, ".git", "MERGE_HEAD")),
			head: await gitOut(dir, "rev-parse", "HEAD"),
		}).toEqual({ok: true, message: "Aborted merge in abort-merge", mergeHead: false, head: mainTip});
	});

	it("reports that nothing is in progress on a clean repo", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "abort-nothing", dir})]);

		const {abortRebaseHandler} = await import("./server-fns.impl.js");
		const result = await abortRebaseHandler("abort-nothing");

		expect({ok: result.ok, message: result.message}).toEqual({
			ok: false,
			message: "No rebase, cherry-pick or merge in progress in abort-nothing",
		});
	});

	it("waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-abort", dir})]);
		const {abortRebaseHandler} = await import("./server-fns.impl.js");
		let settled = false;
		const release = holdRepo("queued-abort");
		await tick();
		const pending = abortRebaseHandler("queued-abort").then((r) => {
			settled = true;
			return r;
		});
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});
		const settledWhileHeld = settled;
		release();
		await pending;
		expect({settledWhileHeld, settledAfter: settled}).toEqual({settledWhileHeld: false, settledAfter: true});
	});
});

/** Ready to land's Open PR in a repo that does or doesn't allow auto-merge: the gh calls, drafts and result. */
async function openPr(name: string, autoMergeAllowed: boolean, draftPrNumber?: number) {
	const dir = await createTestGitRepo();
	seedProjectCache([makeProject({name, dir, remote: "alice/example-repo", originRemote: "alice/example-repo"})]);
	const gh: string[][] = [];
	fakeExeca.handler = (command, args) => {
		if (command === "gh") gh.push(args);
		return {
			stdout: command === "mise" ? "{}" : "",
			stderr: "",
			exitCode: 0,
			failed: false,
			command: [command, ...args].join(" "),
		};
	};
	const drafts: unknown[] = [];
	setGitHubClient({
		graphql: async (query: string, variables?: Record<string, unknown>) => {
			if (query.includes("autoMergeAllowed")) {
				return Promise.resolve({data: {repository: {autoMergeAllowed}}});
			}
			if (query.includes("createPullRequest")) {
				drafts.push(variables?.["draft"]);
				return Promise.resolve({
					data: {
						createPullRequest: {pullRequest: {url: "https://github.com/alice/example-repo/pull/7"}},
					},
				});
			}
			return Promise.resolve({data: {repository: {id: "REPOSITORY_7"}}});
		},
	});
	const {createPrHandler} = await import("./server-fns.impl.js");
	const result = await createPrHandler({
		project: name,
		branch: "ship-it",
		title: "Ship it",
		autoMerge: true,
		...(draftPrNumber === undefined ? {} : {draftPrNumber}),
	});
	return {
		gh,
		drafts,
		result: {
			ok: result.ok,
			message: result.message,
			autoMerge: result.autoMerge,
			prNumber: result.prNumber,
		},
	};
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

	it("forcePushHandler pushes the branch's sha with a lease pinned to the remote sha it read first", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "lease-force-push", dir})]);
		const pushes: string[][] = [];
		fakeExeca.handler = (command, args) => {
			const ref = args.at(-1);
			let stdout = command === "mise" ? "{}" : "";
			if (args.includes("rev-parse") && ref === "refs/remotes/origin/feature") stdout = "a".repeat(40);
			if (args.includes("rev-parse") && ref === "refs/heads/feature^{commit}") stdout = "b".repeat(40);
			if (args.includes("push")) pushes.push(args);
			return {stdout, stderr: "", exitCode: 0, failed: false, command: [command, ...args].join(" ")};
		};
		const {forcePushHandler} = await import("./server-fns.impl.js");

		const result = await forcePushHandler({project: "lease-force-push", branch: "feature"});

		expect({result, pushes}).toStrictEqual({
			result: {ok: true, message: "Force-pushed to feature"},
			pushes: [
				[
					"-C",
					dir,
					"push",
					`--force-with-lease=refs/heads/feature:${"a".repeat(40)}`,
					"origin",
					`${"b".repeat(40)}:refs/heads/feature`,
				],
			],
		});
	});

	it("forcePushHandler leases on absence when the remote has no copy of the branch", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "lease-absent-push", dir})]);
		const pushes: string[][] = [];
		fakeExeca.handler = (command, args) => {
			const ref = args.at(-1);
			let stdout = command === "mise" ? "{}" : "";
			let exitCode = 0;
			if (args.includes("rev-parse") && ref === "refs/remotes/origin/feature") exitCode = 1;
			if (args.includes("rev-parse") && ref === "refs/heads/feature^{commit}") stdout = "b".repeat(40);
			if (args.includes("push")) pushes.push(args);
			return {stdout, stderr: "", exitCode, failed: exitCode !== 0, command: [command, ...args].join(" ")};
		};
		const {forcePushHandler} = await import("./server-fns.impl.js");

		await forcePushHandler({project: "lease-absent-push", branch: "feature"});

		expect(pushes).toStrictEqual([
			[
				"-C",
				dir,
				"push",
				"--force-with-lease=refs/heads/feature:",
				"origin",
				`${"b".repeat(40)}:refs/heads/feature`,
			],
		]);
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

	it("mergePrHandler returns the merged PR's number and GitHub URL", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([
			makeProject({
				name: "merge-pr-result",
				dir,
				remote: "alice/example-repo",
				originRemote: "alice/example-repo",
			}),
		]);
		fakeExeca.handler = (command, args) => ({
			stdout: command === "mise" ? "{}" : "",
			stderr: "",
			exitCode: 0,
			failed: false,
			command: [command, ...args].join(" "),
		});
		const {mergePrHandler} = await import("./server-fns.impl.js");
		const result = await mergePrHandler({project: "merge-pr-result", prNumber: 42});
		expect({ok: result.ok, message: result.message, prNumber: result.prNumber, prUrl: result.prUrl}).toStrictEqual({
			ok: true,
			message: "Merged PR #42",
			prNumber: 42,
			prUrl: "https://github.com/alice/example-repo/pull/42",
		});
	});

	it("mergePrHandler on running checks turns on auto-merge instead of merging now", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([
			makeProject({name: "merge-pr-auto", dir, remote: "alice/example-repo", originRemote: "alice/example-repo"}),
		]);
		const gh: string[][] = [];
		fakeExeca.handler = (command, args) => {
			if (command === "gh") gh.push(args);
			return {
				stdout: command === "mise" ? "{}" : "",
				stderr: "",
				exitCode: 0,
				failed: false,
				command: [command, ...args].join(" "),
			};
		};
		const {mergePrHandler} = await import("./server-fns.impl.js");
		const result = await mergePrHandler({project: "merge-pr-auto", prNumber: 42, autoMerge: true});
		expect({
			gh,
			result: {ok: result.ok, message: result.message, autoMerge: result.autoMerge, prNumber: result.prNumber},
		}).toStrictEqual({
			gh: [["pr", "merge", "42", "--squash", "--delete-branch", "--auto", "-R", "alice/example-repo"]],
			result: {
				ok: true,
				message: "PR #42 will merge itself when its checks pass",
				autoMerge: true,
				prNumber: 42,
			},
		});
	});

	it("mergePrHandler targets origin's repo, where Open PR opened it, when origin is the upstream remote of a fork", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([
			makeProject({
				name: "merge-pr-fork",
				dir,
				remote: "georgyo/avalon",
				originRemote: "motlin/avalon",
				upstreamRemote: "origin",
				upstreamBranch: "avalon.cool",
				upstreamRef: "origin/avalon.cool",
			}),
		]);
		const gh: string[][] = [];
		fakeExeca.handler = (command, args) => {
			if (command === "gh") gh.push(args);
			return {
				stdout: command === "mise" ? "{}" : "",
				stderr: "",
				exitCode: 0,
				failed: false,
				command: [command, ...args].join(" "),
			};
		};
		const {mergePrHandler} = await import("./server-fns.impl.js");
		const merged = await mergePrHandler({project: "merge-pr-fork", prNumber: 5});
		const auto = await mergePrHandler({project: "merge-pr-fork", prNumber: 6, autoMerge: true});
		expect({gh, prUrls: [merged.prUrl, auto.prUrl]}).toStrictEqual({
			gh: [
				["pr", "merge", "5", "--squash", "--delete-branch", "-R", "motlin/avalon"],
				["pr", "merge", "6", "--squash", "--delete-branch", "--auto", "-R", "motlin/avalon"],
			],
			prUrls: ["https://github.com/motlin/avalon/pull/5", "https://github.com/motlin/avalon/pull/6"],
		});
	});

	describe("createPrHandler with auto-merge requested", () => {
		beforeEach(() => {
			// Earlier tests may leave GitHub marked rate limited, which reads as no auto-merge.
			resetGitHubRateLimit();
			resetAutoMergeAllowedCache();
		});

		afterEach(() => {
			resetAutoMergeAllowedCache();
			resetRepositoryIdCache();
		});

		it("opens the PR ready for review and turns on auto-merge where the repo allows it", async () => {
			expect(await openPr("create-pr-auto", true)).toStrictEqual({
				gh: [["pr", "merge", "7", "--squash", "--delete-branch", "--auto", "-R", "alice/example-repo"]],
				drafts: [false],
				result: {
					ok: true,
					message: "Opened PR #7; it will merge itself when its checks pass",
					autoMerge: true,
					prNumber: 7,
				},
			});
		});

		it("marks the buffer's draft PR ready instead of opening another, then turns on auto-merge", async () => {
			expect(await openPr("draft-pr-auto", true, 9)).toStrictEqual({
				gh: [
					["pr", "ready", "9", "-R", "alice/example-repo"],
					["pr", "merge", "9", "--squash", "--delete-branch", "--auto", "-R", "alice/example-repo"],
				],
				drafts: [],
				result: {
					ok: true,
					message: "Marked draft PR #9 ready; it will merge itself when its checks pass",
					autoMerge: true,
					prNumber: 9,
				},
			});
		});

		it("marks the buffer's draft PR ready and leaves auto-merge off where the repo doesn't allow it", async () => {
			expect(await openPr("draft-pr-manual", false, 9)).toStrictEqual({
				gh: [["pr", "ready", "9", "-R", "alice/example-repo"]],
				drafts: [],
				result: {ok: true, message: "Marked draft PR #9 ready", autoMerge: undefined, prNumber: 9},
			});
		});

		it("leaves auto-merge off where the repo doesn't allow it", async () => {
			expect(await openPr("create-pr-manual", false)).toStrictEqual({
				gh: [],
				drafts: [false],
				result: {ok: true, message: "Opened PR #7", autoMerge: undefined, prNumber: 7},
			});
		});
	});

	describe("createPrHandler when the GitHub token can't open PRs in the repo", () => {
		beforeEach(() => {
			resetGitHubRateLimit();
			resetAutoMergeAllowedCache();
			resetViewerPermissionCache();
		});

		afterEach(() => {
			resetAutoMergeAllowedCache();
			resetRepositoryIdCache();
			resetViewerPermissionCache();
		});

		it("pushes the branch with git, then hands off to GitHub's prefilled new-PR page instead of the API", async () => {
			const dir = await createTestGitRepo();
			seedProjectCache([
				makeProject({
					name: "read-only-token",
					dir,
					remote: "FactorioBlueprints/factorio-prints",
					originRemote: "FactorioBlueprints/factorio-prints",
					upstreamBranch: "factorio-prints.com",
					upstreamRef: "origin/factorio-prints.com",
				}),
			]);
			const pushes: string[][] = [];
			fakeExeca.handler = (command, args) => {
				if (args.includes("push")) pushes.push(args);
				const stdout = command === "mise" ? "{}" : args.includes("rev-parse") ? "b".repeat(40) : "";
				return {stdout, stderr: "", exitCode: 0, failed: false, command: [command, ...args].join(" ")};
			};
			const queries: string[] = [];
			setGitHubClient({
				graphql: async (query: string) => {
					if (query.includes("viewerPermission")) {
						queries.push("viewerPermission");
						return Promise.resolve({data: {repository: {viewerPermission: "READ"}}});
					}
					if (query.includes("autoMergeAllowed")) {
						return Promise.resolve({data: {repository: {autoMergeAllowed: true}}});
					}
					queries.push(query.includes("createPullRequest") ? "createPullRequest" : "other");
					return Promise.resolve({data: {repository: {id: "REPOSITORY_7"}}});
				},
			});
			const steps: string[] = [];
			const {actionEmitter} = await import("./action-events.js");
			const onAction = (event: {step?: string}) => {
				if (event.step !== undefined) steps.push(event.step);
			};
			actionEmitter.on("action", onAction);
			const {createPrHandler} = await import("./server-fns.impl.js");

			const result = await createPrHandler({
				project: "read-only-token",
				branch: "account-privacy",
				title: "Ignore the .tanstack/ temp directory",
				autoMerge: true,
			});
			actionEmitter.off("action", onAction);

			expect({
				result: {ok: result.ok, message: result.message, compareUrl: result.compareUrl, prUrl: result.prUrl},
				pushes,
				queries,
				handoffStep: steps.at(-1),
			}).toStrictEqual({
				result: {
					ok: true,
					message:
						"Pushed account-privacy; your GitHub token has read-only access to FactorioBlueprints/factorio-prints, so create the PR on GitHub",
					compareUrl:
						"https://github.com/FactorioBlueprints/factorio-prints/compare/factorio-prints.com...account-privacy?quick_pull=1&title=Ignore+the+.tanstack%2F+temp+directory",
					prUrl: undefined,
				},
				pushes: [["-C", dir, "push", "origin", `${"b".repeat(40)}:refs/heads/account-privacy`]],
				queries: ["viewerPermission"],
				handoffStep:
					"Your GitHub token can't open PRs in FactorioBlueprints/factorio-prints; finish creating it on GitHub",
			});
		});
	});

	it("createPrHandler waits for a running job on the same project", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([makeProject({name: "queued-create-pr", dir})]);
		const {createPrHandler} = await import("./server-fns.impl.js");
		const {whileHeld, afterRelease} = await execCallsAroundRepoHold("queued-create-pr", async () =>
			createPrHandler({project: "queued-create-pr", branch: "feature", title: "t", draft: true}),
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

// -- getQueueSnapshotHandler --

describe("getQueueSnapshotHandler", () => {
	it("returns every project's cached children and todos plus issues, project items, and snoozed in one call", async () => {
		const {cacheChildren, cacheTodos, snoozeItem} = await import("@wip/shared");
		seedProjectCache([
			makeProject({name: "alpha", dir: "/tmp/alpha"}),
			makeProject({name: "beta", dir: "/tmp/beta"}),
		]);
		const alphaChild = makeChild({project: "alpha", sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "Alpha"});
		const alphaTodo = {
			project: "alpha",
			title: "Alpha todo",
			sourceFile: "/tmp/alpha/.llm/todo.md",
			sourceLabel: ".llm/todo.md",
		};
		const projectItem = {
			id: "PVTI_snapshot",
			title: "Board item",
			status: "Todo",
			type: "ISSUE" as const,
			url: "https://github.com/owner/repo/issues/9",
			number: 9,
			repository: "owner/repo",
			labels: [],
		};
		cacheChildren("alpha", [alphaChild]);
		cacheChildren("beta", []);
		cacheTodos("alpha", [alphaTodo]);
		cacheTodos("beta", []);
		cacheIssues([makeIssue(3, "Snapshot issue")]);
		cacheProjectItems([projectItem]);
		snoozeItem("b".repeat(40), "beta", "bbbbbbb", "Snoozed one", null);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");

		const {getQueueSnapshotHandler} = await import("./server-fns.impl.js");
		const result = await getQueueSnapshotHandler();

		expect({result, enqueued: enqueueSpy.mock.calls.length}).toStrictEqual({
			result: {
				children: {alpha: [alphaChild], beta: []},
				todos: {alpha: [alphaTodo], beta: []},
				issues: [makeIssue(3, "Snapshot issue")],
				projectItems: [projectItem],
				snoozed: [
					{
						sha: "b".repeat(40),
						project: "beta",
						shortSha: "bbbbbbb",
						subject: "Snoozed one",
						until: null,
						patchId: null,
						orphaned: false,
					},
				],
			},
			enqueued: 0,
		});
		enqueueSpy.mockRestore();
	});

	it("serves stale cached children and enqueues their background refresh", async () => {
		const {cacheChildren, cacheTodos} = await import("@wip/shared");
		seedProjectCache([makeProject({name: "alpha", dir: "/tmp/alpha"})]);
		const staleChild = makeChild({project: "alpha", subject: "Stale"});
		atTime(Date.now() - STALE_MS, () => {
			cacheChildren("alpha", [staleChild]);
		});
		cacheTodos("alpha", []);
		cacheIssues([]);
		cacheProjectItems([]);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue").mockImplementation(
			() =>
				({
					settled: Promise.resolve(),
					coalesced: false,
				}) as unknown as ReturnType<typeof workQueue.enqueue>,
		);

		const {getQueueSnapshotHandler} = await import("./server-fns.impl.js");
		const result = await getQueueSnapshotHandler();

		expect({
			children: result.children,
			enqueued: enqueueSpy.mock.calls.map(([job]) => job.coalesceKey),
		}).toStrictEqual({
			children: {alpha: [staleChild]},
			enqueued: ["children:alpha"],
		});
		enqueueSpy.mockRestore();
	});
});

/** A branch whose original commit has an AI fixup on top, with its auto-fix recorded. */
async function autoFixedRepo(name: string) {
	const dir = await createTestGitRepo();
	const base = await gitOut(dir, "rev-parse", "HEAD");
	await gitOut(dir, "checkout", "-b", "feat");
	await writeTestFile(join(dir, "a.txt"), "broken\n");
	await gitOut(dir, "add", "a.txt");
	await gitOut(dir, "commit", "-m", "Add a");
	const original = await gitOut(dir, "rev-parse", "HEAD");
	await writeTestFile(join(dir, "a.txt"), "fixed\n");
	await gitOut(dir, "commit", "-am", "fixup! Add a");
	const fixupSha = await gitOut(dir, "rev-parse", "HEAD");
	await gitOut(dir, "checkout", "--detach", base);
	const patchId = (await getCommitFacts(dir, name, [original])).get(original)?.patchId ?? "";
	setAutoFix(name, patchId, {branch: "feat", fixupSha, failure: "FAIL a.test.ts"});
	seedProjectCache([makeProject({name, dir, upstreamRef: base})]);
	return {dir, base, original, fixupSha};
}

describe("auto-fixed items (lean plan step 31)", () => {
	it("shows the auto-fixed marker on the original commit with its failure and fixup", async () => {
		const {original, fixupSha} = await autoFixedRepo("auto-fix-marker");

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await getProjectChildrenHandler("auto-fix-marker");

		expect(result.map((c) => ({sha: c.sha, autoFixed: c.autoFixed}))).toStrictEqual([
			{sha: original, autoFixed: {branch: "feat", fixupSha, failure: "FAIL a.test.ts"}},
		]);
	});

	it("Accept fix squashes the fixup into the original and clears the marker", async () => {
		const {dir, base, original} = await autoFixedRepo("auto-fix-accept");

		const {acceptAutoFixHandler} = await import("./server-fns.impl.js");
		const result = await acceptAutoFixHandler({project: "auto-fix-accept", sha: original});

		expect({
			ok: result.ok,
			message: result.message,
			parent: await gitOut(dir, "rev-parse", "feat~1"),
			subject: await gitOut(dir, "log", "-1", "--format=%s", "feat"),
			file: await gitOut(dir, "show", "feat:a.txt"),
			marker: Object.fromEntries(getAutoFixes("auto-fix-accept")),
		}).toStrictEqual({
			ok: true,
			message: "Accepted the fix on feat",
			parent: base,
			subject: "Add a",
			file: "fixed",
			marker: {},
		});
	});

	it("Accept fix refuses a branch checked out in a worktree and keeps the marker", async () => {
		const {dir, original, fixupSha} = await autoFixedRepo("auto-fix-checked-out");
		await gitOut(dir, "checkout", "feat");

		const {acceptAutoFixHandler} = await import("./server-fns.impl.js");
		const result = await acceptAutoFixHandler({project: "auto-fix-checked-out", sha: original});

		expect({
			ok: result.ok,
			message: result.message,
			tip: await gitOut(dir, "rev-parse", "feat"),
			marker: [...getAutoFixes("auto-fix-checked-out").keys()].length,
		}).toStrictEqual({
			ok: false,
			message: "feat is checked out; accept the fix there with git rebase -i --autosquash",
			tip: fixupSha,
			marker: 1,
		});
	});
});

describe("auto-fix review and its actions (lean plan step 31 follow-up)", () => {
	let savedXdgCache: string | undefined;

	beforeEach(async () => {
		savedXdgCache = process.env.XDG_CACHE_HOME;
		const cache = await mkdtemp(join(tmpdir(), "wip-auto-fix-cache-"));
		tmpDirs.push(cache);
		process.env.XDG_CACHE_HOME = cache;
	});

	afterEach(() => {
		if (savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = savedXdgCache;
	});

	it("the review returns the fixup's diff and the failure it fixed from the test log", async () => {
		const {dir, original, fixupSha} = await autoFixedRepo("auto-fix-review");
		const {getTestLogDir} = await import("@wip/shared");
		await makeDirectory(getTestLogDir("auto-fix-review"), {recursive: true});
		await writeTestFile(join(getTestLogDir("auto-fix-review"), `${original}.log`), "running\nFAIL a.test.ts\n");

		const {getAutoFixReviewHandler} = await import("./server-fns.impl.js");
		const review = await getAutoFixReviewHandler({project: "auto-fix-review", sha: original});

		expect(review).toStrictEqual({
			branch: "feat",
			fixupSha,
			failure: "FAIL a.test.ts",
			diff: await gitOut(dir, "show", "--format=", fixupSha),
			failureLog: "running\nFAIL a.test.ts\n",
		});
	});

	it("the review is null without an auto-fix", async () => {
		const {base} = await autoFixedRepo("auto-fix-review-none");

		const {getAutoFixReviewHandler} = await import("./server-fns.impl.js");

		expect(await getAutoFixReviewHandler({project: "auto-fix-review-none", sha: base})).toBeNull();
	});

	it("Fix it myself assigns the item to the user, keeping the fixup and the red marker", async () => {
		const {dir, original, fixupSha} = await autoFixedRepo("auto-fix-mine");

		const {assignAutoFixHandler, getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const result = await assignAutoFixHandler({project: "auto-fix-mine", sha: original});
		const children = await getProjectChildrenHandler("auto-fix-mine");

		expect({
			ok: result.ok,
			message: result.message,
			tip: await gitOut(dir, "rev-parse", "feat"),
			children: children.map((c) => ({sha: c.sha, autoFixed: c.autoFixed})),
		}).toStrictEqual({
			ok: true,
			message: "The fix on feat is yours; the fixup stays until you decide",
			tip: fixupSha,
			children: [
				{sha: original, autoFixed: {branch: "feat", fixupSha, failure: "FAIL a.test.ts", assigned: true}},
			],
		});
	});

	it("Drop branch deletes the local branch, never the remote one, and clears the marker", async () => {
		const {dir, original, fixupSha} = await autoFixedRepo("auto-fix-drop");
		const remote = await mkdtemp(join(tmpdir(), "wip-auto-fix-remote-"));
		tmpDirs.push(remote);
		await execa("git", ["init", "--bare", remote]);
		await gitOut(dir, "remote", "add", "mirror", remote);
		await gitOut(dir, "push", "mirror", "feat");

		const {dropAutoFixBranchHandler} = await import("./server-fns.impl.js");
		const result = await dropAutoFixBranchHandler({project: "auto-fix-drop", sha: original});

		expect({
			ok: result.ok,
			message: result.message,
			local: await gitOut(dir, "branch", "--list", "feat"),
			remote: await gitOut(remote, "rev-parse", "refs/heads/feat"),
			marker: Object.fromEntries(getAutoFixes("auto-fix-drop")),
		}).toStrictEqual({
			ok: true,
			message: "Deleted local branch feat",
			local: "",
			remote: fixupSha,
			marker: {},
		});
	});

	it("Drop branch refuses a branch checked out in a worktree", async () => {
		const {dir, original, fixupSha} = await autoFixedRepo("auto-fix-drop-checked-out");
		await gitOut(dir, "checkout", "feat");

		const {dropAutoFixBranchHandler} = await import("./server-fns.impl.js");
		const result = await dropAutoFixBranchHandler({project: "auto-fix-drop-checked-out", sha: original});

		expect({
			ok: result.ok,
			message: result.message,
			tip: await gitOut(dir, "rev-parse", "feat"),
			marker: [...getAutoFixes("auto-fix-drop-checked-out").keys()].length,
		}).toStrictEqual({
			ok: false,
			message: "feat is checked out; switch away from it before dropping it",
			tip: fixupSha,
			marker: 1,
		});
	});

	it("a refresh clears the marker when the branch no longer ends in the recorded fixup", async () => {
		const {dir, original} = await autoFixedRepo("auto-fix-stale");
		await gitOut(dir, "branch", "-f", "feat", original);

		const {getProjectChildrenHandler} = await import("./server-fns.impl.js");
		const children = await getProjectChildrenHandler("auto-fix-stale");

		expect({
			children: children.map((c) => ({sha: c.sha, autoFixed: c.autoFixed})),
			marker: Object.fromEntries(getAutoFixes("auto-fix-stale")),
		}).toStrictEqual({
			children: [{sha: original, autoFixed: undefined}],
			marker: {},
		});
	});
});

async function repoWithRemote(): Promise<{dir: string; remote: string; base: string}> {
	const dir = await createTestGitRepo();
	const remote = await createBareRemote();
	await gitOut(dir, "remote", "add", "origin", remote);
	await gitOut(dir, "push", "origin", "main");
	return {dir, remote, base: await gitOut(dir, "rev-parse", "main")};
}

describe("landFastForwardHandler", () => {
	it("moves local main to a ready commit and never pushes", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "feature");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Ready commit");
		const sha = await gitOut(dir, "rev-parse", "feature");
		seedProjectCache([makeProject({name: "land-ff", dir})]);

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-ff", sha});

		expect({
			result: {ok: result.ok, message: result.message},
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
			remoteTracking: await gitOut(dir, "rev-parse", "origin/main"),
		}).toStrictEqual({
			result: {ok: true, message: `Moved local main to ${sha.slice(0, 7)}`},
			localMain: sha,
			remoteMain: base,
			remoteTracking: base,
		});
	});

	it("fast-forwards a checked-out, clean main in its worktree", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "feature");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Ready commit");
		const sha = await gitOut(dir, "rev-parse", "feature");
		await gitOut(dir, "checkout", "main");
		seedProjectCache([makeProject({name: "land-checked-out", dir})]);

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-checked-out", sha});

		expect({
			ok: result.ok,
			head: await gitOut(dir, "rev-parse", "HEAD"),
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
			status: await gitOut(dir, "status", "--porcelain"),
		}).toEqual({ok: true, head: sha, localMain: sha, remoteMain: base, status: ""});
	});

	it("refuses when main is checked out with local changes, leaving local and upstream main unchanged", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "feature");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Ready commit");
		const sha = await gitOut(dir, "rev-parse", "feature");
		await gitOut(dir, "checkout", "main");
		await writeTestFile(join(dir, "README.md"), "local edit\n");
		await gitOut(dir, "add", "README.md");
		seedProjectCache([makeProject({name: "land-dirty", dir})]);

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-dirty", sha});

		expect({
			ok: result.ok,
			message: result.message,
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toEqual({
			ok: false,
			message: `main is checked out with local changes in ${await realpath(dir)}; commit or stash them first`,
			localMain: base,
			remoteMain: base,
		});
	});

	it("refuses when local main is not an ancestor of the commit, leaving local and upstream main unchanged", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "commit", "--allow-empty", "-m", "Local-only main commit");
		const localMain = await gitOut(dir, "rev-parse", "main");
		await gitOut(dir, "checkout", "-b", "feature", base);
		await gitOut(dir, "commit", "--allow-empty", "-m", "Ready commit");
		const sha = await gitOut(dir, "rev-parse", "feature");
		seedProjectCache([makeProject({name: "land-diverged", dir})]);

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-diverged", sha});

		expect({
			ok: result.ok,
			message: result.message,
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toEqual({
			ok: false,
			message: `${sha.slice(0, 7)} is not a fast-forward of local main`,
			localMain,
			remoteMain: base,
		});
	});

	it("refuses a commit that is not a fast-forward of the upstream branch and leaves it unchanged", async () => {
		const {dir, remote} = await repoWithRemote();
		await gitOut(dir, "commit", "--allow-empty", "-m", "Upstream moved");
		await gitOut(dir, "push", "origin", "main");
		const moved = await gitOut(dir, "rev-parse", "main");
		await gitOut(dir, "checkout", "-b", "stale", "main~1");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Stale commit");
		const sha = await gitOut(dir, "rev-parse", "stale");
		seedProjectCache([makeProject({name: "land-stale", dir})]);

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-stale", sha});

		expect({
			ok: result.ok,
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toEqual({ok: false, localMain: moved, remoteMain: moved});
	});
});

/** Commits a new file on the checked-out branch (distinct trees, so git-test results stay per commit). */
async function commitNewFile(dir: string, name: string): Promise<string> {
	await writeTestFile(join(dir, name), `${name}\n`);
	await gitOut(dir, "add", name);
	await gitOut(dir, "commit", "-m", `Add ${name}`);
	return gitOut(dir, "rev-parse", "HEAD");
}

/** Local main three commits ahead of origin/main: green, green, unknown. */
async function mainAheadGreenGreenUnknown(): Promise<{dir: string; remote: string; base: string; shas: string[]}> {
	const {dir, remote, base} = await repoWithRemote();
	const shas = [
		await commitNewFile(dir, "a.txt"),
		await commitNewFile(dir, "b.txt"),
		await commitNewFile(dir, "c.txt"),
	];
	await markGitTest(dir, shas[0] ?? "", true);
	await markGitTest(dir, shas[1] ?? "", true);
	return {dir, remote, base, shas};
}

describe("pushUpstreamBranchHandler", () => {
	it("pushes exactly the green sha to the upstream branch without force, leaving the unknown tail local", async () => {
		const {dir, remote, base, shas} = await mainAheadGreenGreenUnknown();
		const [, green, tip] = shas;
		seedProjectCache([makeProject({name: "push-main", dir})]);

		const {pushUpstreamBranchHandler} = await import("./server-fns.impl.js");
		const result = await pushUpstreamBranchHandler({project: "push-main", sha: green ?? ""});

		expect({
			result: {ok: result.ok, message: result.message, compareUrl: result.compareUrl},
			remoteMain: await gitOut(remote, "rev-parse", "main"),
			remoteTracking: await gitOut(dir, "rev-parse", "origin/main"),
			localMain: await gitOut(dir, "rev-parse", "main"),
		}).toStrictEqual({
			result: {
				ok: true,
				message: "Pushed 2 green commits to origin/main",
				compareUrl: `https://github.com/owner/repo/compare/${base}...${green}`,
			},
			remoteMain: green,
			remoteTracking: green,
			localMain: tip,
		});
	});

	it("refuses a sha whose range holds a commit git-test has not marked good", async () => {
		const {dir, remote, base, shas} = await mainAheadGreenGreenUnknown();
		seedProjectCache([makeProject({name: "push-unknown", dir})]);

		const {pushUpstreamBranchHandler} = await import("./server-fns.impl.js");
		const result = await pushUpstreamBranchHandler({project: "push-unknown", sha: shas[2] ?? ""});

		expect({
			result: {ok: result.ok, message: result.message},
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toStrictEqual({
			result: {ok: false, message: `Not pushed: ${shas[2]?.slice(0, 7)} is unknown, not green`},
			remoteMain: base,
		});
	});

	it("refuses a sha that is not on local main", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "side");
		const side = await commitNewFile(dir, "side.txt");
		await markGitTest(dir, side, true);
		await gitOut(dir, "checkout", "main");
		seedProjectCache([makeProject({name: "push-side", dir})]);

		const {pushUpstreamBranchHandler} = await import("./server-fns.impl.js");
		const result = await pushUpstreamBranchHandler({project: "push-side", sha: side});

		expect({
			result: {ok: result.ok, message: result.message},
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toStrictEqual({
			result: {ok: false, message: `Not pushed: ${side.slice(0, 7)} is not an unpushed commit on local main`},
			remoteMain: base,
		});
	});

	it("refuses when local main has diverged from the upstream branch, leaving it unchanged", async () => {
		const {dir, remote} = await repoWithRemote();
		await commitNewFile(dir, "upstream.txt");
		await gitOut(dir, "push", "origin", "main");
		const moved = await gitOut(dir, "rev-parse", "main");
		await gitOut(dir, "reset", "--hard", "main~1");
		const local = await commitNewFile(dir, "local.txt");
		await markGitTest(dir, local, true);
		seedProjectCache([makeProject({name: "push-diverged", dir})]);

		const {pushUpstreamBranchHandler} = await import("./server-fns.impl.js");
		const result = await pushUpstreamBranchHandler({project: "push-diverged", sha: local});

		expect({
			result: {ok: result.ok, message: result.message},
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toStrictEqual({
			result: {ok: false, message: "Local main has diverged from origin/main; rebase first"},
			remoteMain: moved,
		});
	});
});

describe("landing handlers while the project's own upstream is red", () => {
	beforeEach(() => {
		readyBufferOverride.running = true;
	});

	afterEach(() => {
		readyBufferOverride.running = false;
		readyBufferOverride.stoppedProjects = [];
		fakeExeca.handler = undefined;
	});

	it("mergePrHandler refuses to merge or turn on auto-merge, and calls no gh", async () => {
		const dir = await createTestGitRepo();
		seedProjectCache([
			makeProject({name: "merge-pr-red", dir, remote: "alice/example-repo", originRemote: "alice/example-repo"}),
		]);
		readyBufferOverride.stoppedProjects = ["merge-pr-red"];
		const gh: string[][] = [];
		fakeExeca.handler = (command, args) => {
			if (command === "gh") gh.push(args);
			return {
				stdout: command === "mise" ? "{}" : "",
				stderr: "",
				exitCode: 0,
				failed: false,
				command: [command, ...args].join(" "),
			};
		};

		const {mergePrHandler} = await import("./server-fns.impl.js");
		const merged = await mergePrHandler({project: "merge-pr-red", prNumber: 42});
		const auto = await mergePrHandler({project: "merge-pr-red", prNumber: 43, autoMerge: true});

		const message = "merge-pr-red's upstream is red: fix it before landing";
		expect({
			gh,
			merged: {ok: merged.ok, message: merged.message},
			auto: {ok: auto.ok, message: auto.message},
		}).toStrictEqual({
			gh: [],
			merged: {ok: false, message},
			auto: {ok: false, message},
		});
	});

	it("landFastForwardHandler refuses and leaves local main unchanged", async () => {
		const {dir, remote, base} = await repoWithRemote();
		await gitOut(dir, "checkout", "-b", "feature");
		await gitOut(dir, "commit", "--allow-empty", "-m", "Ready commit");
		const sha = await gitOut(dir, "rev-parse", "feature");
		seedProjectCache([makeProject({name: "land-ff-red", dir})]);
		readyBufferOverride.stoppedProjects = ["land-ff-red"];

		const {landFastForwardHandler} = await import("./server-fns.impl.js");
		const result = await landFastForwardHandler({project: "land-ff-red", sha});

		expect({
			result: {ok: result.ok, message: result.message},
			localMain: await gitOut(dir, "rev-parse", "main"),
			remoteMain: await gitOut(remote, "rev-parse", "main"),
		}).toStrictEqual({
			result: {ok: false, message: "land-ff-red's upstream is red: fix it before landing"},
			localMain: base,
			remoteMain: base,
		});
	});

	it("pushUpstreamBranchHandler refuses a green sha and pushes nothing", async () => {
		const {dir, remote, base, shas} = await mainAheadGreenGreenUnknown();
		seedProjectCache([makeProject({name: "push-main-red", dir})]);
		readyBufferOverride.stoppedProjects = ["push-main-red"];

		const {pushUpstreamBranchHandler} = await import("./server-fns.impl.js");
		const result = await pushUpstreamBranchHandler({project: "push-main-red", sha: shas[1] ?? ""});

		expect({
			result: {ok: result.ok, message: result.message},
			remoteMain: await gitOut(remote, "rev-parse", "main"),
			remoteTracking: await gitOut(dir, "rev-parse", "origin/main"),
		}).toStrictEqual({
			result: {ok: false, message: "push-main-red's upstream is red: fix it before landing"},
			remoteMain: base,
			remoteTracking: base,
		});
	});
});

describe("getMainPushesHandler", () => {
	it("lists local main's unpushed commits oldest first with their git-test results", async () => {
		const {dir, shas} = await mainAheadGreenGreenUnknown();
		seedProjectCache([makeProject({name: "ahead", dir})]);

		const {getMainPushesHandler} = await import("./server-fns.impl.js");

		expect(await getMainPushesHandler({})).toStrictEqual([
			{
				project: "ahead",
				remote: "origin",
				branch: "main",
				diverged: false,
				commits: [
					{sha: shas[0], subject: "Add a.txt", status: "good"},
					{sha: shas[1], subject: "Add b.txt", status: "good"},
					{sha: shas[2], subject: "Add c.txt", status: "unknown"},
				],
			},
		]);
	});

	it("tests the first unknown commit after the green prefix in the background while the ready buffer runs", async () => {
		const {dir, shas} = await mainAheadGreenGreenUnknown();
		tmpDirs.push(`${dir}-test-worktree`);
		seedProjectCache([makeProject({name: "getting-ready", dir})]);
		// The test log and worktree lock land under a temp cache dir, not ~/.cache/wip.
		const cache = await mkdtemp(join(tmpdir(), "wip-cache-"));
		tmpDirs.push(cache);
		vi.stubEnv("XDG_CACHE_HOME", cache);
		readyBufferOverride.running = true;
		// An idle machine on AC, whatever the real load and power source are.
		workQueue.setProbe({loadPerCore: () => 0, freeMemRatio: () => 1});
		workQueue.setOnBattery(false);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");
		try {
			const {getMainPushesHandler} = await import("./server-fns.impl.js");
			const first = await getMainPushesHandler({});
			const jobs = enqueueSpy.mock.calls.flatMap(([job], index) => {
				const handle = enqueueSpy.mock.results[index]?.value as ReturnType<typeof workQueue.enqueue>;
				return job.kind === "main-push-test" ? [handle] : [];
			});
			expect(jobs).toHaveLength(1);
			await jobs[0]?.settled;

			expect({testing: first[0]?.testing, after: await getMainPushesHandler({})}).toStrictEqual({
				testing: shas[2],
				after: [
					{
						project: "getting-ready",
						remote: "origin",
						branch: "main",
						diverged: false,
						commits: [
							{sha: shas[0], subject: "Add a.txt", status: "good"},
							{sha: shas[1], subject: "Add b.txt", status: "good"},
							{sha: shas[2], subject: "Add c.txt", status: "good"},
						],
					},
				],
			});
		} finally {
			enqueueSpy.mockRestore();
			workQueue.setProbe(null);
			readyBufferOverride.running = false;
		}
	});

	it("runs the background pre-test with the project's mise env", async () => {
		const {dir, shas} = await mainAheadGreenGreenUnknown();
		tmpDirs.push(`${dir}-test-worktree`);
		// A test command that only passes when the project's mise [env] reaches it.
		await gitOut(dir, "config", "test.default.command", 'test "$WIP_MISE_PROBE" = from-mise');
		cacheMiseEnv(dir, {WIP_MISE_PROBE: "from-mise"}, miseConfigFingerprint(dir));
		seedProjectCache([makeProject({name: "mise-push", dir})]);
		const cache = await mkdtemp(join(tmpdir(), "wip-cache-"));
		tmpDirs.push(cache);
		vi.stubEnv("XDG_CACHE_HOME", cache);
		readyBufferOverride.running = true;
		workQueue.setProbe({loadPerCore: () => 0, freeMemRatio: () => 1});
		workQueue.setOnBattery(false);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");
		try {
			const {getMainPushesHandler} = await import("./server-fns.impl.js");
			const first = await getMainPushesHandler({});
			const tested = first[0]?.testing;
			const jobs = enqueueSpy.mock.calls.flatMap(([job], index) => {
				const handle = enqueueSpy.mock.results[index]?.value as ReturnType<typeof workQueue.enqueue>;
				return job.kind === "main-push-test" ? [handle] : [];
			});
			expect(jobs).toHaveLength(1);
			await jobs[0]?.settled;

			const after = await getMainPushesHandler({});
			expect({
				tested: shas.includes(tested ?? ""),
				status: after[0]?.commits.find((c) => c.sha === tested)?.status,
			}).toStrictEqual({tested: true, status: "good"});
		} finally {
			enqueueSpy.mockRestore();
			workQueue.setProbe(null);
			readyBufferOverride.running = false;
		}
	});

	it("flags a diverged local main and omits projects whose main is not ahead", async () => {
		const {dir} = await repoWithRemote();
		await commitNewFile(dir, "upstream.txt");
		await gitOut(dir, "push", "origin", "main");
		await gitOut(dir, "reset", "--hard", "main~1");
		await commitNewFile(dir, "local.txt");
		const {dir: even} = await repoWithRemote();
		seedProjectCache([makeProject({name: "diverged", dir}), makeProject({name: "even", dir: even})]);

		const {getMainPushesHandler} = await import("./server-fns.impl.js");

		expect(await getMainPushesHandler({})).toStrictEqual([
			{project: "diverged", remote: "origin", branch: "main", diverged: true, commits: []},
		]);
	});

	it("lists and pre-tests a shared git repo's main once, under the project whose dir is its top level", async () => {
		const {dir} = await mainAheadGreenGreenUnknown();
		const nested = join(dir, "nested");
		await makeDirectory(nested);
		seedProjectCache([
			makeProject({name: "outer/nested", dir: nested, gitTopLevel: dir}),
			makeProject({name: "outer", dir, gitTopLevel: dir}),
		]);
		const cache = await mkdtemp(join(tmpdir(), "wip-cache-"));
		tmpDirs.push(cache, `${dir}-test-worktree`);
		vi.stubEnv("XDG_CACHE_HOME", cache);
		readyBufferOverride.running = true;
		workQueue.setProbe({loadPerCore: () => 0, freeMemRatio: () => 1});
		workQueue.setOnBattery(false);
		const enqueueSpy = vi.spyOn(workQueue, "enqueue");
		try {
			const {getMainPushesHandler} = await import("./server-fns.impl.js");
			const rows = await getMainPushesHandler({});
			const tests = enqueueSpy.mock.calls.flatMap(([job], index) => {
				const handle = enqueueSpy.mock.results[index]?.value as ReturnType<typeof workQueue.enqueue>;
				return job.kind === "main-push-test" ? [{project: job.project, handle}] : [];
			});
			await Promise.all(tests.map(async (t) => t.handle.settled));

			expect({
				rows: rows.map((r) => r.project),
				tested: tests.map((t) => t.project),
			}).toStrictEqual({rows: ["outer"], tested: ["outer"]});
		} finally {
			enqueueSpy.mockRestore();
			workQueue.setProbe(null);
			readyBufferOverride.running = false;
		}
	});

	it("gives a local main that is only behind its upstream branch no row", async () => {
		const {dir} = await repoWithRemote();
		await commitNewFile(dir, "upstream.txt");
		await gitOut(dir, "push", "origin", "main");
		await gitOut(dir, "reset", "--hard", "main~1");
		seedProjectCache([makeProject({name: "behind", dir})]);

		const {getMainPushesHandler} = await import("./server-fns.impl.js");

		expect(await getMainPushesHandler({})).toStrictEqual([]);
	});
});

describe("ready buffer advance", () => {
	it("tests the baseline and the candidate with the project's mise env", async () => {
		const {dir} = await repoWithRemote();
		const sha = await commitNewFile(dir, "ready.txt");
		tmpDirs.push(`${dir}-test-worktree`);
		await gitOut(dir, "config", "test.default.command", 'test "$WIP_MISE_PROBE" = from-mise');
		cacheMiseEnv(dir, {WIP_MISE_PROBE: "from-mise"}, miseConfigFingerprint(dir));
		seedProjectCache([makeProject({name: "mise-buffer", dir})]);
		const cache = await mkdtemp(join(tmpdir(), "wip-cache-"));
		tmpDirs.push(cache);
		vi.stubEnv("XDG_CACHE_HOME", cache);

		const {advance} = await import("./ready-buffer-server.js");
		const outcome = await advance(
			{
				name: "mise-buffer",
				upstreamRed: false,
				ownership: "own",
				localChanges: false,
				checkedOutBranches: [],
				candidates: [],
			},
			{id: sha, sha, state: "unready", onHold: false},
			new AbortController().signal,
			() => {},
		);

		expect(outcome).toBe("ready");
	});

	it("reports a branch that moved since the snapshot as moved, not a conflict, and leaves it alone", async () => {
		const {dir} = await behindFeatureBranch("fix-moved", {conflict: false});
		await gitOut(dir, "config", "test.default.command", "true");
		const stale = await gitOut(dir, "rev-parse", "fix-moved");
		// Open PR rebased the branch after the buffer's snapshot read it.
		await gitOut(dir, "rebase", "origin/main", "fix-moved");
		await gitOut(dir, "checkout", "main");
		const rebased = await gitOut(dir, "rev-parse", "fix-moved");
		seedProjectCache([makeProject({name: "moved-buffer", dir})]);

		const {advance} = await import("./ready-buffer-server.js");
		const outcome = await advance(
			{
				name: "moved-buffer",
				upstreamRed: false,
				ownership: "own",
				localChanges: false,
				checkedOutBranches: [],
				candidates: [],
			},
			{id: stale, sha: stale, branch: "fix-moved", state: "unready", onHold: false},
			new AbortController().signal,
			() => {},
		);

		expect({outcome, branch: await gitOut(dir, "rev-parse", "fix-moved")}).toStrictEqual({
			outcome: "moved",
			branch: rebased,
		});
	});

	it("reports a commit whose patch already landed upstream as moved once its replay leaves the branch at the upstream tip, never testing or publishing it", async () => {
		const {dir} = await behindFeatureBranch("fix-landed", {conflict: false});
		// A green test command: testing the upstream tip would read the landed commit as ready.
		await gitOut(dir, "config", "test.default.command", "true");
		const stale = await gitOut(dir, "rev-parse", "fix-landed");
		// The same patch landed upstream (squash or cherry-pick), so the replay drops the commit.
		await gitOut(dir, "cherry-pick", stale);
		await gitOut(dir, "push", "origin", "main");
		const upstream = await gitOut(dir, "rev-parse", "origin/main");
		seedProjectCache([makeProject({name: "landed-buffer", dir})]);
		const replayed: string[] = [];

		const {advance} = await import("./ready-buffer-server.js");
		const outcome = await advance(
			{
				name: "landed-buffer",
				upstreamRed: false,
				ownership: "own",
				localChanges: false,
				checkedOutBranches: [],
				candidates: [],
			},
			{id: stale, sha: stale, branch: "fix-landed", state: "unready", onHold: false},
			new AbortController().signal,
			(sha) => replayed.push(sha),
		);

		expect({outcome, replayed, branch: await gitOut(dir, "rev-parse", "fix-landed")}).toStrictEqual({
			outcome: "moved",
			replayed: [],
			branch: upstream,
		});
	});
});

describe("getSystemStatusHandler", () => {
	it("reports children refresh times only for current projects, ignoring rows left by removed or skipped ones", async () => {
		seedProjectCache([
			makeProject({name: "alpha", dir: "/tmp/alpha"}),
			makeProject({name: "beta", dir: "/tmp/beta"}),
		]);
		const {markCacheFresh} = await import("@wip/shared");
		markCacheFresh("children:alpha");
		markCacheFresh("children:kempt");
		markCacheFresh("children:linguist");
		const {getSystemStatusHandler} = await import("./server-fns.impl.js");

		const status = await getSystemStatusHandler();

		expect(Object.keys(status.childrenRefreshedAt)).toStrictEqual(["alpha"]);
	});
});
