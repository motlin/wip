import type {GitHubActionsGate} from "@wip/shared";
import {log} from "@wip/shared/services/logger-pino.js";
import {
	bufferRepoFromChildren,
	createReadyBuffer,
	readyBufferEnabled,
	testStep,
	type AdvanceOutcome,
	type BufferCandidate,
	type BufferRepo,
	type ReadyBuffer,
} from "./ready-buffer.js";
import type {OnHoldSignal} from "./ready-buffer-events.js";
import {
	createBackgroundPusher,
	publishAfterAdvance,
	type BackgroundPusher,
	type PushRequest,
} from "./background-push.js";
import {markLocalTestSkipped} from "./local-test-skipped.js";
import {workQueue} from "./shared-work-queue.js";

/**
 * Production wiring for the ready buffer (lean plan 4.6): the snapshot reads each project's
 * cached children, the advance job runs steps 1-3 (baseline, replay, test, or the patch-id fast
 * path's push and PR when the repo trusts a pre-replay green), a replay conflict gets
 * one silent `/git:conflicts` agent, a test failure one `/build:fix` agent that must commit a
 * separate fixup (recorded as "auto-fixed" until accepted), and the signals
 * (upstreamMoved, landed, task completion, On hold, children refresh, safety tick) trigger pulls.
 * A ready item in a pull-request repo is force-pushed with lease through the one GitHub Actions
 * gate (plan step 34); a held push is deferred and retried on the children and tick signals.
 */

const SAFETY_TICK_MS = 45_000;
const CHECKED_OUT_TTL_MS = 60_000;

const checkedOutCache = new Map<string, {at: number; branches: string[]}>();

/** Worktree branches, cached briefly: every pull reads them, and the advance job re-checks live. */
async function checkedOut(dir: string): Promise<string[]> {
	const hit = checkedOutCache.get(dir);
	if (hit && Date.now() - hit.at < CHECKED_OUT_TTL_MS) return hit.branches;
	const {checkedOutBranches} = await import("@wip/shared");
	const branches = [...(await checkedOutBranches(dir))];
	checkedOutCache.set(dir, {at: Date.now(), branches});
	return branches;
}

async function snapshot(): Promise<BufferRepo[]> {
	const {
		getCachedChildren,
		getGitHubIdentity,
		getPriorityOverride,
		isOnHold,
		landingMode,
		loadInventory,
		trustsPatchIdGreen,
	} = await import("@wip/shared");
	const {getProjects} = await import("./server-fns.js");
	const identity = await getGitHubIdentity();
	const registry = new Map(loadInventory().projects.map((r) => [r.dir, r]));
	const repos: BufferRepo[] = [];
	for (const p of await getProjects()) {
		const children = getCachedChildren(p.name);
		if (!children) continue;
		const record = registry.get(p.dir);
		const priority = record?.priority;
		const needsBranches = children.some((c) => c.kind !== "upstream_ci" && c.branch !== undefined);
		repos.push(
			bufferRepoFromChildren(p, children, {
				identity,
				...(priority === undefined ? {} : {priority}),
				// Sequential on purpose: one cheap git call per project, cached
				// eslint-disable-next-line no-await-in-loop
				checkedOutBranches: needsBranches && !p.dirty ? await checkedOut(p.dir) : [],
				onHold: (child) => isOnHold(p.name, {sha: child.sha, patchId: child.patchId}),
				override: (patchId) => getPriorityOverride(p.name, {kind: "commit", key: patchId}),
				trustPatchIdGreen: record !== undefined && trustsPatchIdGreen(record),
				...(record === undefined ? {} : {landing: landingMode(record)}),
			}),
		);
	}
	return repos;
}

/** Steps 1-3 of 4.6 for one candidate. Never checks out, adds no worktrees or branches. */
async function advance(repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal): Promise<AdvanceOutcome> {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const {
		checkedOutBranches,
		DEFAULT_GIT_TEST,
		getTestLogDir,
		gitTestResults,
		gitTestRun,
		parseFailedTests,
		replayBranchOnto,
	} = await import("@wip/shared");
	const {tracedExeca} = await import("@wip/shared/services/traced-execa.js");
	const {getProjects} = await import("./server-fns.js");
	const p = (await getProjects()).find((proj) => proj.name === repo.name);
	if (!p || p.dirty) return "skipped";
	const upstream = (
		await tracedExeca("git", ["-C", p.dir, "rev-parse", p.upstreamRef], {reject: false})
	).stdout.trim();
	if (upstream === "") return "skipped";
	const logDir = getTestLogDir(p.name);

	const failedTests = async (s: string): Promise<ReadonlySet<string> | null> => {
		try {
			return parseFailedTests(await fs.promises.readFile(path.join(logDir, `${s}.log`), "utf8"));
		} catch {
			return null;
		}
	};

	// 1. A red baseline (unknown is run first) stops this item until upstream moves when the
	// upstream is own; the next children refresh reports it as upstream red. A foreign red baseline
	// whose log names its failing tests becomes the bar instead (step 35): no new failures.
	let baselineFailures: ReadonlySet<string> | undefined;
	if (p.hasTestConfigured) {
		const baseline = (await gitTestResults(p.dir, DEFAULT_GIT_TEST, [upstream])).get(upstream);
		const red =
			baseline === "bad" || (baseline !== "good" && (await gitTestRun(p.dir, upstream, {logDir})).exitCode !== 0);
		if (red) {
			if (repo.ownership === "own") return "skipped";
			// A cached bad with no log left: rerun once so the log names the failures.
			if (!fs.existsSync(path.join(logDir, `${upstream}.log`))) {
				await gitTestRun(p.dir, upstream, {logDir, retest: true});
			}
			const failures = await failedTests(upstream);
			if (failures === null) return "skipped";
			baselineFailures = failures;
		}
	}
	if (signal.aborted) return "skipped";

	// 2. Replay onto upstream unless it already sits on it.
	let sha = candidate.sha;
	const onUpstream =
		(await tracedExeca("git", ["-C", p.dir, "merge-base", "--is-ancestor", upstream, sha], {reject: false}))
			.exitCode === 0;
	if (!onUpstream) {
		if (candidate.branch === undefined) return "skipped";
		if ((await checkedOutBranches(p.dir)).has(candidate.branch)) return "skipped";
		const replayed = await replayBranchOnto(p.dir, candidate.branch, candidate.sha, upstream);
		if (replayed === null) return "rebase_conflicts";
		sha = replayed;
	}

	// 3. The exit code of `git test run` decides, unless the patch-id fast path publishes instead.
	const {branch} = candidate;
	const pushRequest = (s: string): PushRequest | null =>
		branch === undefined ? null : {project: p.name, dir: p.dir, repository: p.remote, branch, sha: s};
	const outcome = await testStep(
		{
			trustPatchIdGreen: repo.trustPatchIdGreen === true,
			hasTestConfigured: p.hasTestConfigured,
			preReplaySha: candidate.sha,
			sha,
			replayed: !onUpstream,
			...(baselineFailures === undefined ? {} : {baselineFailures}),
		},
		{
			results: async (s) => (await gitTestResults(p.dir, DEFAULT_GIT_TEST, [s])).get(s) ?? "unknown",
			run: async (s) => (await gitTestRun(p.dir, s, {logDir})).exitCode,
			publish: async (s) => {
				const request = pushRequest(s);
				if (request === null || !(await publishForChecks(p, request, candidate.sha))) return false;
				markLocalTestSkipped(p.name, s);
				return true;
			},
			failedTests,
		},
	);

	// 4. Step 34: a ready item in a pull-request repo is force-pushed with lease through the gate.
	const request = pushRequest(sha);
	if (request !== null) {
		const pushed = await publishAfterAdvance({landing: repo.landing, outcome, request}, backgroundPusher());
		if (pushed !== null) log.general.info({project: p.name, branch, sha, push: pushed}, "Ready-buffer push");
	}
	return outcome;
}

let gate: GitHubActionsGate | null = null;
let pusher: BackgroundPusher | null = null;

/** The one pusher, and so the one GitHub Actions gate, for every background push in this process. */
function backgroundPusher(): BackgroundPusher {
	pusher ??= createBackgroundPusher({
		gate: {
			// Created on first use, so the node-only checks source loads lazily.
			check: async () => {
				const {GitHubActionsGate: Gate, githubChecksSource} = await import("@wip/shared");
				gate ??= new Gate(githubChecksSource);
				return gate.check();
			},
			recordPush: (push) => {
				gate?.recordPush(push);
			},
		},
		git: async (args) => {
			const {tracedExeca} = await import("@wip/shared/services/traced-execa.js");
			const result = await tracedExeca("git", [...args], {reject: false});
			return {exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr};
		},
	});
	return pusher;
}

/**
 * The fast path's publish: force-push the replayed branch with lease to origin (where PR heads
 * live) through the gate, without deferring a held push (the advance then runs the local test),
 * and open a draft PR when the commit had none; an existing PR updates with the push.
 */
async function publishForChecks(
	p: {name: string; dir: string; remote: string; originRemote: string; upstreamBranch: string},
	request: PushRequest,
	preReplaySha: string,
): Promise<boolean> {
	const {createPullRequest, getCachedChildren, invalidatePrCache} = await import("@wip/shared");
	const {branch} = request;
	const push = await backgroundPusher().push(request, {defer: false});
	if (push.status === "held" || push.status === "failed") {
		log.general.warn({project: p.name, branch, push}, "Ready-buffer fast-path push not done");
		return false;
	}
	invalidatePrCache(p.name);
	const child = getCachedChildren(p.name)?.find((c) => c.sha === preReplaySha);
	if (child?.prNumber !== undefined) return true;
	const [owner, name] = p.remote.split("/");
	const [originOwner] = p.originRemote.split("/");
	if (!owner || !name) return false;
	const created = await createPullRequest({
		owner,
		name,
		baseRefName: p.upstreamBranch,
		headRefName: p.originRemote !== p.remote && originOwner ? `${originOwner}:${branch}` : branch,
		title: child?.subject ?? branch,
		body: "",
		draft: true,
	});
	if (!created.ok)
		log.general.warn({project: p.name, branch, message: created.message}, "Ready-buffer fast-path PR failed");
	return created.ok;
}

/** The candidate's project as the AI rungs see it; null when it is gone or has local changes. */
async function rungProject(repo: BufferRepo) {
	const {getProjects} = await import("./server-fns.js");
	const p = (await getProjects()).find((proj) => proj.name === repo.name);
	if (!p || p.dirty) return null;
	return {
		name: p.name,
		path: p.dir,
		upstreamRemote: p.upstreamRemote,
		upstreamBranch: p.upstreamBranch,
		dirty: p.dirty,
		detached: false,
		rebaseInProgress: false,
		offline: false,
	};
}

async function branchTip(dir: string, branch: string): Promise<string | null> {
	const {tracedExeca} = await import("@wip/shared/services/traced-execa.js");
	const tip = await tracedExeca("git", ["-C", dir, "rev-parse", branch], {reject: false});
	return tip.exitCode === 0 ? tip.stdout.trim() : null;
}

/**
 * Step 30: resolve a replay conflict silently with one `/git:conflicts` agent in a throwaway
 * worktree (no focus); the resolved branch tip re-enters the advance at the test.
 */
async function resolveConflicts(
	repo: BufferRepo,
	candidate: BufferCandidate,
	signal: AbortSignal,
): Promise<string | null> {
	if (candidate.branch === undefined) return null;
	const {aiRungDeps, resolveBranchConflict} = await import("./herdr/ai-rungs.js");
	const project = await rungProject(repo);
	if (!project) return null;
	if ((await resolveBranchConflict(project, candidate.branch, aiRungDeps(), signal)) === "stuck") return null;
	return branchTip(project.path, candidate.branch);
}

/**
 * Step 31: fix the failing test with one `/build:fix` agent that must commit a separate fixup on
 * top of the failing tip. The failing run's log is the one wip's own `git test run` just wrote,
 * so the repeated-failure signature is populated. The fixup is recorded as "auto-fixed: <failure>"
 * by the failing commit's patch-id; the advance then retests the fixup.
 */
async function fixTest(repo: BufferRepo, candidate: BufferCandidate, signal: AbortSignal): Promise<string | null> {
	if (candidate.branch === undefined) return null;
	const fs = await import("node:fs");
	const path = await import("node:path");
	const {failureSummary, getCommitFacts, getTestLogDir, setAutoFix} = await import("@wip/shared");
	const {aiRungDeps, fixTestAsFixup} = await import("./herdr/ai-rungs.js");
	const project = await rungProject(repo);
	if (!project) return null;
	const failing = await branchTip(project.path, candidate.branch);
	if (failing === null) return null;
	const logPath = path.join(getTestLogDir(project.name), `${failing}.log`);
	const fixup = await fixTestAsFixup(project, candidate.branch, failing, logPath, aiRungDeps(), signal);
	if (fixup === null) return null;
	let failureLog = "";
	try {
		failureLog = fs.readFileSync(logPath, "utf8");
	} catch {
		// No log: the marker falls back to a generic failure label.
	}
	const patchId = (await getCommitFacts(project.path, project.name, [failing])).get(failing)?.patchId ?? candidate.id;
	setAutoFix(project.name, patchId, {branch: candidate.branch, fixupSha: fixup, failure: failureSummary(failureLog)});
	return fixup;
}

let buffer: ReadyBuffer | null = null;

function warnOnFailure(promise: Promise<void>, signal: string): void {
	promise.catch((error: unknown) => {
		log.general.error({error, signal}, "Ready-buffer pull failed");
	});
}

/**
 * Once-only: create the controller and subscribe it to every pull signal. Skipped when
 * WIP_READY_BUFFER turns it off, or when another wip process already runs it (a process lock
 * under the shared cache dir), so two servers never replay and test the same repos.
 */
export async function startReadyBuffer(
	enqueueProjectRefresh: (project: string, options: {force: boolean}) => void,
): Promise<void> {
	if (buffer) return;
	if (!readyBufferEnabled(process.env)) {
		log.general.info("Ready buffer disabled by WIP_READY_BUFFER");
		return;
	}
	const {acquireProcessLock, getReadyBufferCapacity, getReadyBufferSize} = await import("@wip/shared");
	if (acquireProcessLock("ready-buffer") === null) {
		log.general.warn("Ready buffer already running in another wip process; not starting it here");
		return;
	}
	const started = createReadyBuffer({
		queue: workQueue,
		snapshot,
		// Read per pull so a config change takes effect without a restart.
		target: () => getReadyBufferSize(),
		capacity: () => getReadyBufferCapacity(),
		advance: async (repo, candidate, signal) => {
			const outcome = await advance(repo, candidate, signal);
			log.general.info({project: repo.name, sha: candidate.sha, outcome}, "Ready-buffer advance");
			// The replay and test changed what the cards show.
			enqueueProjectRefresh(repo.name, {force: true});
			return outcome;
		},
		resolveConflicts: async (repo, candidate, signal) => {
			const resolved = await resolveConflicts(repo, candidate, signal);
			log.general.info({project: repo.name, sha: candidate.sha, resolved}, "Ready-buffer conflict resolution");
			enqueueProjectRefresh(repo.name, {force: true});
			return resolved;
		},
		fixTest: async (repo, candidate, signal) => {
			const fixup = await fixTest(repo, candidate, signal);
			log.general.info({project: repo.name, sha: candidate.sha, fixup}, "Ready-buffer test fix");
			enqueueProjectRefresh(repo.name, {force: true});
			return fixup;
		},
	});
	buffer = started;

	const {emitter: mergeEmitter} = await import("./merge-queue.js");
	mergeEmitter.on("upstreamMoved", (event: {project: string}) => {
		warnOnFailure(started.upstreamMoved(event.project), "upstreamMoved");
	});
	mergeEmitter.on("landed", (event: {project: string}) => {
		warnOnFailure(started.landed(event.project), "landed");
	});
	const {emitter: taskEmitter} = await import("./task-queue.js");
	taskEmitter.on("task", (event: {type: string; status: string}) => {
		if (event.type !== "status" || event.status === "queued" || event.status === "running") return;
		warnOnFailure(started.pull(), "task");
	});
	const {readyBufferEmitter} = await import("./ready-buffer-events.js");
	readyBufferEmitter.on("onHold", (event: OnHoldSignal) => {
		warnOnFailure(started.onHold(event.project), "onHold");
	});
	const {childrenEmitter} = await import("./children-events.js");
	childrenEmitter.on("children", () => {
		warnOnFailure(started.pull(), "children");
		warnOnFailure(backgroundPusher().flush(), "push-flush");
	});
	setInterval(() => {
		warnOnFailure(started.pull(), "tick");
		warnOnFailure(backgroundPusher().flush(), "push-flush");
	}, SAFETY_TICK_MS).unref();
	warnOnFailure(started.pull(), "start");
}
