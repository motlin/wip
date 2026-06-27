import {tracedExeca} from "../services/traced-execa.js";
import {getTestResultsForProject} from "./db.js";

/**
 * DAG-frontier planner for the advance loop.
 *
 * Across all branch tips that contain the upstream ref, commits form a DAG.
 * Y-shaped branches share an ancestor prefix; re-spawning a worker for each
 * branch would walk that shared trunk more than once. The planner assigns every
 * commit beyond the upstream ref to exactly one unit (the first to own it in a
 * deterministic order) and records cross-unit dependencies, so the shared trunk
 * is advanced once and divergent tips fan out afterward.
 */

export interface AdvanceUnit {
	id: string;
	project: string;
	branch: string;
	tipSha: string;
	/** Commits this unit owns, newest-first, with shared ancestors removed. */
	chain: string[];
	/** Unit ids that own this unit's shared ancestors and must go green first. */
	dependsOn: string[];
	worktreeRequired: boolean;
}

export interface AdvancePlan {
	project: string;
	upstreamRef: string;
	units: AdvanceUnit[];
	baseline: {sha: string; needsTest: boolean};
}

async function git(dir: string, args: string[]): Promise<string> {
	const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false});
	return result.exitCode === 0 ? result.stdout.trim() : "";
}

export async function planProject(opts: {project: string; dir: string; upstreamRef: string}): Promise<AdvancePlan> {
	const {project, dir, upstreamRef} = opts;

	const baselineSha = await git(dir, ["rev-parse", upstreamRef]);

	const currentBranch = await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

	const tipNames = (
		await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/", "--contains", upstreamRef])
	)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const tips: Array<{branch: string; tipSha: string; chain: string[]}> = [];
	for (const branch of tipNames) {
		const chainOutput = await git(dir, ["rev-list", `${upstreamRef}..${branch}`]);
		const chain = chainOutput.split("\n").filter((sha) => sha.length > 0);
		if (chain.length === 0) continue; // upstream branch itself / fully merged
		tips.push({branch, tipSha: chain[0]!, chain});
	}

	// Shortest chains first so the most-shared prefix lands on the simplest branch;
	// name tie-break keeps the plan deterministic.
	tips.sort((a, b) => a.chain.length - b.chain.length || a.branch.localeCompare(b.branch));

	const owner = new Map<string, string>();
	const units: AdvanceUnit[] = [];
	for (const tip of tips) {
		const ownedNew = tip.chain.filter((sha) => !owner.has(sha));
		const dependsOn = [...new Set(tip.chain.filter((sha) => owner.has(sha)).map((sha) => owner.get(sha)!))];
		for (const sha of ownedNew) owner.set(sha, tip.branch);
		units.push({
			id: tip.branch,
			project,
			branch: tip.branch,
			tipSha: tip.tipSha,
			chain: ownedNew,
			dependsOn,
			worktreeRequired: tip.branch !== currentBranch,
		});
	}

	const baselineGreen = getTestResultsForProject(project).get(baselineSha) === "passed";

	return {
		project,
		upstreamRef,
		units,
		baseline: {sha: baselineSha, needsTest: !baselineGreen},
	};
}
