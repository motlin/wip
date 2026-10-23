import * as fs from "node:fs";
import * as path from "node:path";

import {tracedExeca, type ExecaResult} from "../services/traced-execa.js";
import {getCacheDir} from "./config.js";
import {planLadder, type LadderProjectInfo, type LadderResult, type LadderRungName} from "./ladder.js";

/**
 * Ladder rungs that never touch the main checkout: fetch, replay, and rebase-leftovers. Server-only
 * (spawns subprocesses); do not import from client-reachable modules.
 */

export interface LadderRungProject {
	name: string;
	/** Absolute project directory, used as the recipe's cwd. */
	path: string;
	upstreamRemote: string;
	upstreamBranch: string;
	/** Aborts running subprocesses (execa cancelSignal). */
	signal?: AbortSignal | undefined;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}(?:\\[[0-9;]*m|\\(B)`, "g");

async function runRecipe(project: LadderRungProject, recipeArgs: string[]): Promise<ExecaResult> {
	return tracedExeca("just", ["--global-justfile", ...recipeArgs], {
		cwd: project.path,
		// The global justfile runs `tput` at load time, which fails when TERM is unset (servers, CI).
		env: {
			UPSTREAM_REMOTE: project.upstreamRemote,
			UPSTREAM_BRANCH: project.upstreamBranch,
			TERM: process.env["TERM"] ?? "xterm-256color",
		},
		extendEnv: true,
		reject: false,
		...(project.signal ? {cancelSignal: project.signal} : {}),
	});
}

function errorResult(project: LadderRungProject, rung: LadderRungName, result: ExecaResult): LadderResult {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
	return {
		project: project.name,
		rungs: [{rung, status: "stopped", detail}],
		stop: {stop: "error", branches: []},
	};
}

export async function runFetchRung(project: LadderRungProject): Promise<LadderResult> {
	const result = await runRecipe(project, ["fetch"]);
	if (result.exitCode !== 0) return errorResult(project, "fetch", result);
	return {
		project: project.name,
		rungs: [{rung: "fetch", status: "passed", detail: `fetched ${project.upstreamRemote}`}],
	};
}

/** Extracts branch names listed under "Failed to replay N branch(es):". */
function parseFailedReplayBranches(output: string): string[] {
	const lines = output.replace(ANSI_PATTERN, "").split("\n");
	const start = lines.findIndex((line) => line.includes("Failed to replay") && line.includes("branch(es)"));
	if (start === -1) return [];
	const branches: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const match = line.match(/^\s+-\s+(\S+)\s*$/);
		if (!match?.[1]) break;
		branches.push(match[1]);
	}
	return branches;
}

export async function runReplayRung(project: LadderRungProject): Promise<LadderResult> {
	const result = await runRecipe(project, ["replay-all", "true"]);
	const failed = parseFailedReplayBranches(result.stdout);
	if (failed.length > 0) {
		return {
			project: project.name,
			rungs: [{rung: "replay", status: "stopped", detail: `failed to replay ${failed.length} branch(es)`}],
			stop: {stop: "conflict", branches: failed},
		};
	}
	if (result.exitCode !== 0) return errorResult(project, "replay", result);
	return {project: project.name, rungs: [{rung: "replay", status: "passed", detail: "replayed"}]};
}

async function gitIn(dir: string, args: string[], signal?: AbortSignal): Promise<ExecaResult> {
	return tracedExeca("git", ["-C", dir, ...args], signal ? {reject: false, cancelSignal: signal} : {reject: false});
}

/**
 * Rebases every local branch that still lacks the upstream ref and is not checked out
 * in any worktree. Each runs in a throwaway detached worktree so the user's checkout
 * is never touched; conflicts are aborted and reported, never forced.
 */
export async function runRebaseLeftoversRung(project: LadderRungProject): Promise<LadderResult> {
	const upstream = `${project.upstreamRemote}/${project.upstreamBranch}`;
	const branchList = await gitIn(
		project.path,
		["for-each-ref", "--format=%(refname:short)", "refs/heads"],
		project.signal,
	);
	if (branchList.exitCode !== 0) return errorResult(project, "rebase-leftovers", branchList);
	const worktrees = await gitIn(project.path, ["worktree", "list", "--porcelain"], project.signal);
	if (worktrees.exitCode !== 0) return errorResult(project, "rebase-leftovers", worktrees);
	const checkedOut = new Set(
		worktrees.stdout
			.split("\n")
			.filter((line) => line.startsWith("branch refs/heads/"))
			.map((line) => line.slice("branch refs/heads/".length)),
	);

	const leftovers: string[] = [];
	/* oxlint-disable no-await-in-loop -- git subprocesses run one at a time: worktree add/remove contend on the repo lock and rebases are heavy */
	for (const branch of branchList.stdout.split("\n").filter(Boolean)) {
		if (checkedOut.has(branch)) continue;
		const contains = await gitIn(project.path, ["merge-base", "--is-ancestor", upstream, branch], project.signal);
		if (contains.exitCode !== 0) leftovers.push(branch);
	}

	const rebased: string[] = [];
	const conflicts: string[] = [];
	const base = path.join(getCacheDir(), "rebase-worktrees", project.name);
	fs.mkdirSync(base, {recursive: true});
	for (const branch of leftovers) {
		const dir = fs.mkdtempSync(path.join(base, "wt-"));
		const added = await gitIn(project.path, ["worktree", "add", "--detach", dir, branch], project.signal);
		if (added.exitCode !== 0) {
			fs.rmSync(dir, {recursive: true, force: true});
			conflicts.push(branch);
			continue;
		}
		const rebase = await gitIn(
			dir,
			["rebase", "--rebase-merges", "--update-refs", upstream, branch],
			project.signal,
		);
		if (rebase.exitCode === 0) {
			rebased.push(branch);
		} else {
			await gitIn(dir, ["rebase", "--abort"]);
			conflicts.push(branch);
		}
		// Detach so the worktree no longer pins the branch, then remove without force.
		await gitIn(dir, ["checkout", "--detach", "-q"]);
		await gitIn(project.path, ["worktree", "remove", dir]);
	}
	/* oxlint-enable no-await-in-loop */
	await gitIn(project.path, ["worktree", "prune"], project.signal);

	if (conflicts.length > 0) {
		return {
			project: project.name,
			rungs: [
				{
					rung: "rebase-leftovers",
					status: "stopped",
					detail: `${conflicts.length} branch(es) could not be rebased`,
				},
			],
			stop: {stop: "conflict", branches: conflicts},
		};
	}
	return {
		project: project.name,
		rungs: [{rung: "rebase-leftovers", status: "passed", detail: `rebased ${rebased.length} branch(es)`}],
	};
}

export async function runPruneRung(project: LadderRungProject): Promise<LadderResult> {
	const result = await gitIn(project.path, ["worktree", "prune"], project.signal);
	if (result.exitCode !== 0) return errorResult(project, "worktree-prune", result);
	return {project: project.name, rungs: [{rung: "worktree-prune", status: "passed", detail: "pruned worktrees"}]};
}

/**
 * Deletes local branches merged into the upstream ref with `git branch -d` (never -D). Skips the
 * current branch, branches checked out in any worktree, and the upstream branch's own name.
 * Remote branches are never touched.
 */
export async function runDeleteMergedLocalRung(project: LadderRungProject): Promise<LadderResult> {
	const upstream = `remotes/${project.upstreamRemote}/${project.upstreamBranch}`;
	const merged = await gitIn(
		project.path,
		["branch", "--merged", upstream, "--format=%(refname:short)"],
		project.signal,
	);
	if (merged.exitCode !== 0) return errorResult(project, "delete-merged-local", merged);
	const worktrees = await gitIn(project.path, ["worktree", "list", "--porcelain"], project.signal);
	if (worktrees.exitCode !== 0) return errorResult(project, "delete-merged-local", worktrees);
	const checkedOut = new Set(
		worktrees.stdout
			.split("\n")
			.filter((line) => line.startsWith("branch refs/heads/"))
			.map((line) => line.slice("branch refs/heads/".length)),
	);

	let deleted = 0;
	/* oxlint-disable no-await-in-loop -- branch deletions take the repo ref lock; run one at a time */
	for (const branch of merged.stdout.split("\n").filter(Boolean)) {
		if (checkedOut.has(branch) || branch === project.upstreamBranch) continue;
		const result = await gitIn(project.path, ["branch", "-d", branch], project.signal);
		if (result.exitCode === 0) deleted++;
	}
	/* oxlint-enable no-await-in-loop */
	return {
		project: project.name,
		rungs: [{rung: "delete-merged-local", status: "passed", detail: `deleted ${deleted} branch(es)`}],
	};
}

export type LadderRunner = (project: LadderRungProject) => Promise<LadderResult>;

const DEFAULT_LADDER_RUNNERS: Record<LadderRungName, LadderRunner> = {
	fetch: runFetchRung,
	replay: runReplayRung,
	"rebase-leftovers": runRebaseLeftoversRung,
	"worktree-prune": runPruneRung,
	"delete-merged-local": runDeleteMergedLocalRung,
};

export interface RunLadderOptions {
	/** Return the plan as skipped rungs without running anything. */
	dryRun?: boolean;
	/** Checked between rungs and passed to subprocesses. */
	signal?: AbortSignal;
	/** Override rung implementations (tests). */
	runners?: Record<LadderRungName, LadderRunner>;
}

export type LadderRunProject = LadderRungProject & Omit<LadderProjectInfo, "project">;

/** Runs the planned rungs in order, stopping at the first stopped rung. */
export async function runLadder(project: LadderRunProject, options: RunLadderOptions = {}): Promise<LadderResult> {
	const runners = options.runners ?? DEFAULT_LADDER_RUNNERS;
	const plan = planLadder({
		project: project.name,
		dirty: project.dirty,
		detached: project.detached,
		rebaseInProgress: project.rebaseInProgress,
		offline: project.offline,
	});
	if (options.dryRun) {
		return {
			project: project.name,
			rungs: plan.map((r) => ({rung: r.rung, status: "skipped", detail: "dry run"})),
		};
	}
	const rungProject: LadderRungProject = {
		name: project.name,
		path: project.path,
		upstreamRemote: project.upstreamRemote,
		upstreamBranch: project.upstreamBranch,
		signal: options.signal,
	};
	const result: LadderResult = {project: project.name, rungs: []};
	/* oxlint-disable no-await-in-loop -- rungs are ordered and must run one at a time */
	for (const {rung} of plan) {
		if (options.signal?.aborted) {
			result.rungs.push({rung, status: "stopped", detail: "aborted"});
			result.stop = {stop: "error", branches: []};
			return result;
		}
		const rungResult = await runners[rung](rungProject);
		result.rungs.push(...rungResult.rungs);
		if (rungResult.stop) {
			result.stop = rungResult.stop;
			return result;
		}
	}
	/* oxlint-enable no-await-in-loop */
	return result;
}
