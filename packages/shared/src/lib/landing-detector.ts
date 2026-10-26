import {tracedExeca} from "../services/traced-execa.js";
import {getCommitFacts} from "./commit-facts.js";
import {git} from "./git-exec.js";
import {isOnHold} from "./snooze-identity.js";

/**
 * Replay-first landing detection (plan 4.7).
 *
 * After upstream moves (or a PR reports MERGED), each suspected tip is checked:
 * a tip already reachable from the new upstream landed by fast-forward; a tip with
 * patch-id evidence (one of its commits has a patch-id that appears in the new
 * upstream range) is replayed onto upstream with `git replay`, which drops the
 * commits upstream already has. The replay outcome decides: a tip that replays to
 * exactly the upstream tip landed; anything left on top is work remaining. A
 * MERGED PR counts as landed on its own.
 *
 * On hold tips and branches checked out in any worktree are skipped. A branch
 * tip that replays cleanly is moved to the replayed tip (compare-and-swap on the
 * old sha); unnamed tips touch no ref.
 */

export interface LandingSuspect {
	sha: string;
	branch?: string;
	prMerged?: boolean;
}

/** Flags suspects whose branch has a MERGED PR whose head is exactly the suspect's tip. */
export function markMergedPrs(
	suspects: readonly LandingSuspect[],
	merged: ReadonlyArray<{branch: string; headOid: string}>,
): LandingSuspect[] {
	const mergedHeads = new Set(merged.map((pr) => `${pr.branch}\u0000${pr.headOid}`));
	return suspects.map((suspect) =>
		suspect.branch !== undefined && mergedHeads.has(`${suspect.branch}\u0000${suspect.sha}`)
			? {...suspect, prMerged: true}
			: suspect,
	);
}

export type LandingOutcome =
	| {sha: string; branch?: string; outcome: "landed" | "remaining"; newTip: string}
	| {sha: string; branch?: string; outcome: "conflict"};

export interface DetectLandingsInput {
	dir: string;
	project: string;
	/** The previous upstream tip, or null when unknown. */
	from: string | null;
	to: string;
	suspects: LandingSuspect[];
}

function lines(output: string): string[] {
	return output.split("\n").filter(Boolean);
}

async function checkedOutBranches(dir: string): Promise<Set<string>> {
	const output = await git(dir, "worktree", "list", "--porcelain");
	const branches = new Set<string>();
	for (const line of lines(output)) {
		if (line.startsWith("branch refs/heads/")) branches.add(line.slice("branch refs/heads/".length));
	}
	return branches;
}

async function isAncestor(dir: string, sha: string, of: string): Promise<boolean> {
	const result = await tracedExeca("git", ["-C", dir, "merge-base", "--is-ancestor", sha, of], {reject: false});
	return result.exitCode === 0;
}

/** True when one of the tip's commits since the old upstream has a patch-id that appears in the new upstream range. */
async function hasPatchIdEvidence(
	dir: string,
	project: string,
	tip: string,
	from: string | null,
	to: string,
): Promise<boolean> {
	const own = lines(await git(dir, "rev-list", "--no-merges", `${from ?? to}..${tip}`));
	const upstream = lines(await git(dir, "rev-list", "--no-merges", from ? `${from}..${to}` : `${tip}..${to}`));
	if (own.length === 0 || upstream.length === 0) return false;
	const facts = await getCommitFacts(dir, project, [...own, ...upstream]);
	const upstreamIds = new Set(upstream.map((sha) => facts.get(sha)?.patchId).filter(Boolean));
	return own.some((sha) => {
		const patchId = facts.get(sha)?.patchId;
		return patchId !== undefined && patchId !== "" && upstreamIds.has(patchId);
	});
}

const PROBE_REF = "refs/wip/landing-probe";

/** Replays `to..tip` onto `to` without updating any ref; returns the new tip, or null on conflict. */
async function replayOnto(dir: string, tip: string, to: string): Promise<string | null> {
	const result = await tracedExeca(
		"git",
		["-C", dir, "replay", "--ref-action=print", `--ref=${PROBE_REF}`, `--onto=${to}`, `${to}..${tip}`],
		{reject: false},
	);
	if (result.exitCode !== 0) return null;
	const update = lines(result.stdout).find((line) => line.startsWith(`update ${PROBE_REF} `));
	return update?.split(" ")[2] ?? null;
}

async function detectOne(
	input: DetectLandingsInput,
	suspect: LandingSuspect,
	checkedOut: Set<string>,
): Promise<LandingOutcome | undefined> {
	const {dir, project, from, to} = input;
	const {sha, branch} = suspect;
	const named = branch === undefined ? {} : {branch};

	if (branch !== undefined && checkedOut.has(branch)) return undefined;
	const patchId = (await getCommitFacts(dir, project, [sha])).get(sha)?.patchId;
	if (isOnHold(project, {sha, patchId: patchId === "" ? undefined : patchId})) return undefined;

	if (suspect.prMerged) return {sha, ...named, outcome: "landed", newTip: sha};
	if (await isAncestor(dir, sha, to)) return {sha, ...named, outcome: "landed", newTip: sha};
	if (!(await hasPatchIdEvidence(dir, project, sha, from, to))) return undefined;

	const newTip = await replayOnto(dir, sha, to);
	if (newTip === null) return {sha, ...named, outcome: "conflict"};
	if (branch !== undefined) await git(dir, "update-ref", `refs/heads/${branch}`, newTip, sha);
	return {sha, ...named, outcome: newTip === to ? "landed" : "remaining", newTip};
}

/** Outcomes for the suspects that had a reason to check; suspects with no evidence are left out. */
export async function detectLandings(input: DetectLandingsInput): Promise<LandingOutcome[]> {
	const checkedOut = input.suspects.some((s) => s.branch !== undefined)
		? await checkedOutBranches(input.dir)
		: new Set<string>();
	const outcomes: LandingOutcome[] = [];
	for (const suspect of input.suspects) {
		// Sequential on purpose: each check spawns git subprocesses under the shared gate.
		// eslint-disable-next-line no-await-in-loop
		const outcome = await detectOne(input, suspect, checkedOut);
		if (outcome) outcomes.push(outcome);
	}
	return outcomes;
}

/**
 * Tips that may have landed after upstream moved from `from` to `to`: every local
 * branch (other than main/master) that does not contain `to`, plus children of
 * `from` that are on no branch and not on upstream (unnamed work).
 */
export async function findLandingSuspects(dir: string, from: string | null, to: string): Promise<LandingSuspect[]> {
	const suspects: LandingSuspect[] = [];
	const refs = lines(
		await git(dir, "for-each-ref", "--format=%(objectname) %(refname:short)", `--no-contains=${to}`, "refs/heads/"),
	);
	for (const line of refs) {
		const [sha, branch] = line.split(" ");
		if (!sha || !branch || branch === "main" || branch === "master") continue;
		suspects.push({sha, branch});
	}
	if (!from) return suspects;

	const children = lines(await git(dir, "rev-list", "--parents", "--all", `^${from}`))
		.map((line) => line.split(" "))
		.filter(([, ...parents]) => parents.includes(from))
		.map(([sha]) => sha ?? "");
	if (children.length === 0) return suspects;

	const heads = lines(await git(dir, "for-each-ref", "--format=%(objectname)", "refs/heads/"));
	const covered = new Set(lines(await git(dir, "rev-list", to, ...heads, `^${from}`)));
	for (const sha of children) if (!covered.has(sha)) suspects.push({sha});
	return suspects;
}
