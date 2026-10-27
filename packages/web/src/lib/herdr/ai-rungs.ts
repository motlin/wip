import * as fs from "node:fs";
import * as path from "node:path";
import {
	changeIdentity,
	DEFAULT_GIT_TEST,
	getAiMaxAttempts,
	getAiRungTimeoutMs,
	getCacheDir,
	getCommitFacts,
	getTestLogDir,
	gitTestResults,
	normalizeFailureSignature,
	RunMemory,
	runLadder,
	runReplayRung,
	runRebaseLeftoversRung,
	type LadderResult,
	type LadderRunProject,
	type GitTestStatus,
	type LadderStopInfo,
	type WorkQueue,
} from "@wip/shared";
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
import {repoResource} from "../repo-resource.js";
import {workQueue} from "../shared-work-queue.js";
import type {HerdrResult} from "./client.js";
import {launchInHerdr, type HerdrLaunchRequest, type HerdrLaunchResult} from "./launch.js";
import {waitForHerdrAgent, type HerdrWaitOptions, type HerdrWaitResult} from "./watch.js";

/**
 * AI ladder rungs: hand a stopped ladder to an interactive claude session in a visible herdr tab,
 * holding a queue slot until the agent finishes. Server-only.
 */

export interface AiRungDeps {
	queue: WorkQueue;
	launch: (request: HerdrLaunchRequest) => Promise<HerdrResult<HerdrLaunchResult>>;
	wait: (paneId: string, options: HerdrWaitOptions) => Promise<HerdrWaitResult>;
	/** Re-runs the cheap ladder rungs (replay + rebase leftovers) after the agent finished. */
	rerun: (project: LadderRunProject, signal: AbortSignal) => Promise<LadderResult>;
	/** Reads the stored `git test` results for a branch after the agent finished. */
	results: (project: LadderRunProject, branch: string) => Promise<"green" | "red">;
	timeoutMs: number;
	/** Creates the throwaway worktree with the rebase stopped on its conflict; null when it cannot. */
	prepare: (project: LadderRunProject, branch: string) => Promise<PreparedConflictWorktree | null>;
	/** Creates the throwaway worktree with the branch checked out for the test/fix agent; null when it cannot. */
	prepareTestFix: (project: LadderRunProject, branch: string) => Promise<PreparedTestFixWorktree | null>;
	/** Resolves a branch tip sha; used to detect a test/fix run that left the same red tip. Defaults to git rev-parse. */
	tip?: (project: LadderRunProject, branch: string) => Promise<string>;
	/** Cap on test/fix attempts per branch (defaults to config aiMaxAttempts, 10). */
	maxAttempts?: number;
	/** Called with the herdr tab and pane once the agent tab is launched. */
	onLaunched?: (launched: HerdrLaunchResult) => void;
	/** Failure signatures seen per change; shared across runs by default, so a repeat stops even in a later run. */
	memory?: RunMemory;
	/** A branch's stable change identity (patch-id of its first non-green commit, else branch). */
	identity?: (project: LadderRunProject, branch: string) => Promise<string>;
	/** The failure log of a red branch's first bad commit; empty when none is recorded. */
	failureLog?: (project: LadderRunProject, branch: string) => Promise<string>;
	/** Called when a repeated failure signature stops a branch, so the red set can show it. */
	onRepeatedFailure?: (branch: string, signature: string) => void;
}

/** Process-wide memory of failure signatures per change, shared by the conflict and test/fix rungs. */
const aiRunMemory = new RunMemory();

/** The signature of output with no failure lines; it identifies nothing, so it never counts as a repeat. */
const EMPTY_SIGNATURE = normalizeFailureSignature("");

/**
 * Records a failure signature for a change. Returns the signature when the same change already
 * failed this way (the AI did not change the outcome, so retrying is pointless), else null.
 */
async function repeatedFailure(
	memory: RunMemory,
	project: string,
	identity: () => Promise<string>,
	kind: "test" | "conflicts",
	log: string,
): Promise<string | null> {
	const signature = normalizeFailureSignature(log);
	if (signature === EMPTY_SIGNATURE) return null;
	const unit = {project, changeIdentity: await identity()};
	if (memory.seen(unit, kind, signature)) return signature;
	memory.record(unit, kind, signature);
	return null;
}

export interface PreparedConflictWorktree {
	/** Worktree directory holding the stopped rebase; the agent's cwd. */
	cwd: string;
	/** False when the rebase finished without conflict, so no agent is needed. */
	conflicted: boolean;
	/** The rebase's combined output, whose conflict lines form the failure signature. */
	log: string;
	/** Aborts an unfinished rebase, detaches, removes the worktree (never --force); false when the rebase was unfinished. */
	finish: () => Promise<boolean>;
}

export interface PreparedTestFixWorktree {
	/** Worktree directory with the branch checked out; the agent's cwd. */
	cwd: string;
	/** Detaches and removes the worktree without --force, so one the agent left dirty stays. */
	finish: () => Promise<void>;
}

async function git(dir: string, args: string[]) {
	return tracedExeca("git", ["-C", dir, ...args], {reject: false});
}

/**
 * Starts `git rebase --rebase-merges --update-refs <upstream> <branch>` in a throwaway worktree under
 * the wip cache dir and leaves it stopped on the conflict. The branch ref only moves if the rebase
 * completes; the main checkout is never touched.
 */
async function prepareConflictWorktree(
	project: LadderRunProject,
	branch: string,
): Promise<PreparedConflictWorktree | null> {
	const base = path.join(getCacheDir(), "conflict-worktrees", project.name);
	fs.mkdirSync(base, {recursive: true});
	const dir = fs.mkdtempSync(path.join(base, "wt-"));
	const added = await git(project.path, ["worktree", "add", "--detach", dir, branch]);
	if (added.exitCode !== 0) {
		fs.rmSync(dir, {recursive: true, force: true});
		return null;
	}
	const upstream = `${project.upstreamRemote}/${project.upstreamBranch}`;
	const rebase = await git(dir, ["rebase", "--rebase-merges", "--update-refs", upstream, branch]);
	const finish = async (): Promise<boolean> => {
		const inProgress = await Promise.all(
			["rebase-merge", "rebase-apply"].map(async (name) => {
				const out = await git(dir, ["rev-parse", "--git-path", name]);
				return fs.existsSync(path.resolve(dir, out.stdout.trim()));
			}),
		);
		const unfinished = inProgress.some(Boolean);
		if (unfinished) await git(dir, ["rebase", "--abort"]);
		await git(dir, ["checkout", "--detach", "-q"]);
		await git(project.path, ["worktree", "remove", dir]);
		await git(project.path, ["worktree", "prune"]);
		return !unfinished;
	};
	const log = [rebase.stdout, rebase.stderr].filter(Boolean).join("\n");
	return {cwd: dir, conflicted: rebase.exitCode !== 0, log, finish};
}

/**
 * Checks the branch out in a throwaway worktree under the wip cache dir, so the test/fix agent's
 * `git test run` never checks commits out in the user's checkout. Null when git refuses, e.g.
 * because the branch is checked out there.
 */
export async function prepareTestFixWorktree(
	project: LadderRunProject,
	branch: string,
): Promise<PreparedTestFixWorktree | null> {
	const base = path.join(getCacheDir(), "test-fix-worktrees", project.name);
	fs.mkdirSync(base, {recursive: true});
	const dir = fs.mkdtempSync(path.join(base, "wt-"));
	const added = await git(project.path, ["worktree", "add", dir, branch]);
	if (added.exitCode !== 0) {
		fs.rmSync(dir, {recursive: true, force: true});
		return null;
	}
	const finish = async (): Promise<void> => {
		await git(dir, ["checkout", "--detach", "-q"]);
		await git(project.path, ["worktree", "remove", dir]);
		await git(project.path, ["worktree", "prune"]);
	};
	return {cwd: dir, finish};
}

const noop = async (project: {name: string}): Promise<LadderResult> =>
	Promise.resolve({project: project.name, rungs: []});

async function defaultRerun(project: LadderRunProject, signal: AbortSignal): Promise<LadderResult> {
	return runLadder(project, {
		signal,
		runners: {
			fetch: noop,
			"worktree-prune": noop,
			"delete-merged-local": noop,
			replay: runReplayRung,
			"rebase-leftovers": runRebaseLeftoversRung,
		},
	});
}

/** Green only when at least one commit is listed and git-test reports every one good. */
export function branchVerdict(statuses: ReadonlyMap<string, GitTestStatus>): "green" | "red" {
	return statuses.size > 0 && [...statuses.values()].every((status) => status === "good") ? "green" : "red";
}

async function defaultResults(project: LadderRunProject, branch: string): Promise<"green" | "red"> {
	const range = `${project.upstreamRemote}/${project.upstreamBranch}..${branch}`;
	const revList = await git(project.path, ["rev-list", range]);
	if (revList.exitCode !== 0) return "red";
	const shas = revList.stdout.split("\n").filter((sha) => sha.length > 0);
	// A branch with no commits beyond upstream has nothing to test.
	if (shas.length === 0) return "green";
	try {
		return branchVerdict(await gitTestResults(project.path, DEFAULT_GIT_TEST, shas));
	} catch {
		return "red";
	}
}

async function branchShas(project: LadderRunProject, branch: string): Promise<string[]> {
	const range = `${project.upstreamRemote}/${project.upstreamBranch}..${branch}`;
	const revList = await git(project.path, ["rev-list", "--reverse", range]);
	if (revList.exitCode !== 0) return [];
	return revList.stdout.split("\n").filter((sha) => sha.length > 0);
}

/** The oldest commit on the branch that git-test does not report good; null when all are good. */
async function firstNonGood(project: LadderRunProject, branch: string): Promise<string | null> {
	const shas = await branchShas(project, branch);
	if (shas.length === 0) return null;
	try {
		const statuses = await gitTestResults(project.path, DEFAULT_GIT_TEST, shas);
		return shas.find((sha) => statuses.get(sha) !== "good") ?? null;
	} catch {
		return shas[0] ?? null;
	}
}

async function defaultIdentity(project: LadderRunProject, branch: string): Promise<string> {
	const sha = (await firstNonGood(project, branch)) ?? (await branchShas(project, branch)).at(-1);
	if (!sha) return branch;
	const facts = await getCommitFacts(project.path, project.name, [sha]);
	return changeIdentity({patchId: facts.get(sha)?.patchId ?? "", branch, sha});
}

async function defaultFailureLog(project: LadderRunProject, branch: string): Promise<string> {
	const sha = await firstNonGood(project, branch);
	if (!sha) return "";
	try {
		return fs.readFileSync(path.join(getTestLogDir(project.name), `${sha}.log`), "utf8");
	} catch {
		return "";
	}
}

function shellQuote(text: string): string {
	return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Production rung deps with optional overrides. */
export function aiRungDeps(overrides: Partial<AiRungDeps> = {}): AiRungDeps {
	return {
		queue: workQueue,
		launch: launchInHerdr,
		wait: waitForHerdrAgent,
		rerun: defaultRerun,
		results: defaultResults,
		prepare: prepareConflictWorktree,
		prepareTestFix: prepareTestFixWorktree,
		timeoutMs: getAiRungTimeoutMs(),
		...overrides,
	};
}

/**
 * Resolves one branch's rebase conflict with `claude "/git:conflicts <branch>"` in a herdr tab, in a
 * throwaway worktree stopped on the conflict; runs inside the caller's queue job. "resolved" once the
 * rebase finished (the branch ref moved), else "stuck": no worktree, a repeated failure signature,
 * no tab, a timeout, or a rebase the agent left unfinished.
 */
export async function resolveBranchConflict(
	project: LadderRunProject,
	branch: string,
	deps: AiRungDeps,
	signal: AbortSignal,
): Promise<"resolved" | "stuck"> {
	const prepared = await deps.prepare(project, branch);
	if (!prepared) return "stuck";
	let agentDone = false;
	let completed = false;
	try {
		agentDone = !prepared.conflicted || (await runConflictAgent(project, branch, prepared, deps, signal));
	} finally {
		completed = await prepared.finish();
	}
	return agentDone && completed ? "resolved" : "stuck";
}

async function runConflictAgent(
	project: LadderRunProject,
	branch: string,
	prepared: PreparedConflictWorktree,
	deps: AiRungDeps,
	signal: AbortSignal,
): Promise<boolean> {
	const memory = deps.memory ?? aiRunMemory;
	const identity = async () => (deps.identity ?? defaultIdentity)(project, branch);
	const repeated = await repeatedFailure(memory, project.name, identity, "conflicts", prepared.log);
	if (repeated) {
		deps.onRepeatedFailure?.(branch, repeated);
		return false;
	}
	const launched = await deps.launch({
		cwd: prepared.cwd,
		label: `wip:${project.name}:conflicts`,
		command: `claude ${shellQuote(`/git:conflicts ${branch}`)}`,
		focus: false,
	});
	if (!launched.ok) return false;
	deps.onLaunched?.(launched.value);
	return (await deps.wait(launched.value.paneId, {timeoutMs: deps.timeoutMs, signal})) === "done";
}

/**
 * Resolve rebase conflicts with `claude "/git:conflicts"` in a herdr tab. Returns the new ladder
 * result, or "stuck" when the timeout fires, herdr cannot launch the tab, or a branch that
 * conflicted before still conflicts after the agent ran.
 */
export async function runAiConflictRung(
	project: LadderRunProject,
	stop: LadderStopInfo,
	overrides: Partial<AiRungDeps> = {},
): Promise<LadderResult | "stuck"> {
	const deps = aiRungDeps(overrides);
	let outcome: LadderResult | "stuck" = "stuck";
	const handle = deps.queue.enqueue({
		coalesceKey: `ai-rung:conflicts:${project.name}`,
		resources: [repoResource(project.name)],
		kind: "ai-conflicts",
		project: project.name,
		costClass: "ai",
		run: async (signal) => {
			// One branch per launch, each in its own throwaway worktree stopped on the rebase conflict.
			/* oxlint-disable no-await-in-loop -- one agent at a time per project */
			for (const branch of stop.branches) {
				if ((await resolveBranchConflict(project, branch, deps, signal)) === "stuck") return;
			}
			/* oxlint-enable no-await-in-loop */
			const next = await deps.rerun(project, signal);
			const again = next.stop?.stop === "conflict" && next.stop.branches.some((b) => stop.branches.includes(b));
			outcome = again ? "stuck" : next;
		},
	});
	await handle.settled;
	return outcome;
}

/**
 * Test and fix a branch with `claude "/build:test-branch"` in a herdr tab, in the branch's own
 * throwaway worktree so the user's checkout is never touched. Afterwards reads
 * `git test results` for the branch: "green" or "red", or "stuck" when the timeout fires or
 * herdr cannot launch the tab.
 */
export async function runAiTestFixRung(
	project: LadderRunProject,
	branch: string,
	overrides: Partial<AiRungDeps> = {},
): Promise<"green" | "red" | "stuck"> {
	const deps = aiRungDeps(overrides);

	let outcome: "green" | "red" | "stuck" = "stuck";
	const handle = deps.queue.enqueue({
		coalesceKey: `ai-rung:test-fix:${project.name}:${branch}`,
		resources: [repoResource(project.name)],
		kind: "ai-test-fix",
		project: project.name,
		costClass: "ai",
		run: async (signal) => {
			const prepared = await deps.prepareTestFix(project, branch);
			if (!prepared) return;
			try {
				const launched = await deps.launch({
					cwd: prepared.cwd,
					label: `wip:${project.name}:test-fix:${branch}`,
					command: `claude ${shellQuote("/build:test-branch")}`,
					focus: false,
				});
				if (!launched.ok) return;
				deps.onLaunched?.(launched.value);
				const waited = await deps.wait(launched.value.paneId, {timeoutMs: deps.timeoutMs, signal});
				if (waited !== "done") return;
				outcome = await deps.results(project, branch);
			} finally {
				await prepared.finish();
			}
		},
	});
	await handle.settled;
	return outcome;
}

async function defaultTip(project: LadderRunProject, branch: string): Promise<string> {
	const out = await git(project.path, ["rev-parse", branch]);
	return out.stdout.trim();
}

export interface AiTestFixLoopResult {
	status: "green" | "stuck";
	attempts: number;
	/** The normalized failure signature when a repeat of it stopped the loop. */
	signature?: string;
}

/**
 * Runs the test/fix rung repeatedly for one branch. A red run is retried while the branch tip keeps
 * changing; the branch is stuck when the same change fails with a signature already seen (even on a
 * new tip), the same tip comes back red twice, the attempt cap is reached, or a run times out /
 * cannot launch.
 */
export async function runAiTestFixLoop(
	project: LadderRunProject,
	branch: string,
	overrides: Partial<AiRungDeps> = {},
	onAttempt?: (progress: {status: "running" | "red"; attempts: number}) => void,
): Promise<AiTestFixLoopResult> {
	const tip = overrides.tip ?? defaultTip;
	const cap = overrides.maxAttempts ?? getAiMaxAttempts();
	const memory = overrides.memory ?? aiRunMemory;
	let lastRedTip: string | undefined;
	let attempts = 0;
	/* oxlint-disable no-await-in-loop -- attempts are sequential: each depends on the previous tip */
	while (attempts < cap) {
		attempts += 1;
		onAttempt?.({status: "running", attempts});
		const outcome = await runAiTestFixRung(project, branch, overrides);
		if (outcome === "green") return {status: "green", attempts};
		if (outcome === "stuck") return {status: "stuck", attempts};
		const identity = async () => (overrides.identity ?? defaultIdentity)(project, branch);
		const log = await (overrides.failureLog ?? defaultFailureLog)(project, branch);
		const signature = await repeatedFailure(memory, project.name, identity, "test", log);
		if (signature) {
			overrides.onRepeatedFailure?.(branch, signature);
			return {status: "stuck", attempts, signature};
		}
		const redTip = await tip(project, branch);
		if (redTip === lastRedTip) return {status: "stuck", attempts};
		lastRedTip = redTip;
		onAttempt?.({status: "red", attempts});
	}
	/* oxlint-enable no-await-in-loop */
	return {status: "stuck", attempts};
}
