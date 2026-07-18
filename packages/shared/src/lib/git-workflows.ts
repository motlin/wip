import {tracedExeca} from "../services/traced-execa.js";
import {cacheMergeStatus, getCachedUpstreamSha} from "./db.js";

export interface ApplyFixesOptions {
	branch: string;
	prNumber: number;
	env?: Record<string, string>;
}

/**
 * Cherry-pick every origin/fix-<prNumber>-* branch onto the PR branch, amend
 * them into the tip commit, and force-push the result.
 */
export async function applyFixesToBranch(
	dir: string,
	options: ApplyFixesOptions,
): Promise<{ok: boolean; message: string}> {
	const {branch, prNumber, env} = options;

	await tracedExeca("git", ["-C", dir, "fetch", "origin"], {reject: false, env});

	const branchListResult = await tracedExeca(
		"git",
		["-C", dir, "branch", "-r", "--list", `origin/fix-${prNumber}-*`],
		{reject: false, env},
	);
	if (branchListResult.exitCode !== 0 || !branchListResult.stdout.trim()) {
		return {ok: false, message: `No fix branches found for PR #${prNumber}`};
	}

	const fixBranches = branchListResult.stdout
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
	if (fixBranches.length === 0) {
		return {ok: false, message: `No fix branches found for PR #${prNumber}`};
	}

	const checkout = await tracedExeca("git", ["-C", dir, "checkout", branch], {
		reject: false,
		env,
	});
	if (checkout.exitCode !== 0) {
		return {ok: false, message: `Failed to checkout ${branch}: ${checkout.stderr}`};
	}

	const appliedFixes: string[] = [];
	for (const fixBranch of fixBranches) {
		const cp = await tracedExeca("git", ["-C", dir, "cherry-pick", "--no-commit", fixBranch], {
			reject: false,
			env,
		});
		if (cp.exitCode !== 0) {
			await tracedExeca("git", ["-C", dir, "cherry-pick", "--abort"], {
				reject: false,
				env,
			});
			await tracedExeca("git", ["-C", dir, "reset", "--hard", "HEAD"], {
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

	const diffIndex = await tracedExeca("git", ["-C", dir, "diff", "--cached", "--quiet"], {
		reject: false,
		env,
	});
	if (diffIndex.exitCode === 0) {
		return {ok: false, message: "Fix branches had no changes to apply"};
	}

	const amend = await tracedExeca("git", ["-C", dir, "commit", "--amend", "--no-edit"], {
		reject: false,
		env,
	});
	if (amend.exitCode !== 0) {
		return {ok: false, message: `Failed to amend commit: ${amend.stderr}`};
	}

	const push = await tracedExeca("git", ["-C", dir, "push", "origin", `${branch}:${branch}`, "--force-with-lease"], {
		reject: false,
		env,
	});
	if (push.exitCode !== 0) {
		return {ok: false, message: `Amended commit but failed to push: ${push.stderr}`};
	}

	return {
		ok: true,
		message: `Applied fixes from ${appliedFixes.join(", ")} and force-pushed to ${branch}`,
	};
}

export interface RebaseBranchOptions {
	branch: string;
	/** Project name, used to record merge status on conflict. */
	project: string;
	upstreamRef: string;
	/** Remote to fetch before rebasing; skipped when absent. */
	upstreamRemote?: string;
	/** When set, fetch only this ref from upstreamRemote instead of the whole remote. */
	fetchBranch?: string;
	/** Rebase with --rebase-merges --update-refs. */
	rebaseMerges?: boolean;
	/** Push destination; defaults to the branch's configured remote, falling back to "origin". */
	pushRemote?: string;
	/** Branch to check out after a rebase failure, push failure, or success (not after checkout failure). */
	restoreBranch?: string;
	env?: Record<string, string>;
	/** Receives combined stdout+stderr of each git step, for live log streaming. */
	onOutput?: (chunk: string) => void;
}

export type RebaseBranchResult =
	| {ok: true; message: string}
	| {ok: false; stage: "checkout" | "rebase" | "push"; stderr: string};

/**
 * Fetch upstream, rebase a branch onto it, and force-push (with lease) to the
 * branch's remote. On conflict the rebase is aborted and the branch is recorded
 * as non-rebaseable in the merge-status cache.
 */
export async function rebaseBranchOntoUpstream(dir: string, options: RebaseBranchOptions): Promise<RebaseBranchResult> {
	const {branch, project, upstreamRef, upstreamRemote, fetchBranch, rebaseMerges, restoreBranch, env, onOutput} =
		options;

	const run = async (args: string[]) => {
		const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false, env});
		if (onOutput) {
			const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
			if (out) onOutput(out);
		}
		return result;
	};

	const restore = async (): Promise<void> => {
		if (restoreBranch) await run(["checkout", restoreBranch]);
	};

	if (upstreamRemote) {
		await run(fetchBranch ? ["fetch", upstreamRemote, fetchBranch] : ["fetch", upstreamRemote]);
	}

	const checkout = await run(["checkout", branch]);
	if (checkout.exitCode !== 0) {
		return {ok: false, stage: "checkout", stderr: checkout.stderr};
	}

	const branchSha = (await tracedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false, env})).stdout.trim();

	const rebaseArgs = rebaseMerges
		? ["rebase", "--rebase-merges", "--update-refs", upstreamRef]
		: ["rebase", upstreamRef];
	const rebase = await run(rebaseArgs);
	if (rebase.exitCode !== 0) {
		await run(["rebase", "--abort"]);
		const upstreamSha = getCachedUpstreamSha(project);
		if (upstreamSha && branchSha) {
			cacheMergeStatus(project, branchSha, upstreamSha, 0, 1, false);
		}
		await restore();
		return {ok: false, stage: "rebase", stderr: rebase.stderr};
	}

	const pushRemote =
		options.pushRemote ??
		((await tracedExeca("git", ["-C", dir, "config", `branch.${branch}.remote`], {reject: false})).stdout.trim() ||
			"origin");
	const push = await run(["push", pushRemote, `${branch}:${branch}`, "--force-with-lease"]);
	if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
		await restore();
		return {ok: false, stage: "push", stderr: push.stderr};
	}

	await restore();
	return {ok: true, message: `Rebased ${branch} onto ${upstreamRef}`};
}
