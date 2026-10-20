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
	/* eslint-disable no-await-in-loop -- cherry-picks mutate one working tree and must run strictly in order */
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
	/* eslint-enable no-await-in-loop */

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
	/** Aborting kills the running git step and skips every step after it. */
	signal?: AbortSignal;
}

export type RebaseBranchResult =
	| {ok: true; message: string}
	| {ok: false; stage: "checkout" | "rebase" | "push" | "cancelled"; stderr: string};

function cancelledRebase(): RebaseBranchResult {
	return {ok: false, stage: "cancelled", stderr: ""};
}

/**
 * Fetch upstream, rebase a branch onto it, and force-push (with lease) to the
 * branch's remote. On conflict the rebase is aborted and the branch is recorded
 * as non-rebaseable in the merge-status cache.
 */
export async function rebaseBranchOntoUpstream(dir: string, options: RebaseBranchOptions): Promise<RebaseBranchResult> {
	const {
		branch,
		project,
		upstreamRef,
		upstreamRemote,
		fetchBranch,
		rebaseMerges,
		restoreBranch,
		env,
		onOutput,
		signal,
	} = options;

	// Only the long-running git steps are cancellable. Cleanup (rebase --abort,
	// restoring the branch) always runs so an aborted rebase never leaves the
	// repository mid-rebase or on the wrong branch.
	const run = async (args: string[], cancelSignal?: AbortSignal) => {
		const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false, env, cancelSignal});
		if (onOutput) {
			const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
			if (out) onOutput(out);
		}
		return result;
	};

	// Target for restore(): an explicit restoreBranch wins, otherwise the ref that
	// was checked out before this rebase started (set below, before checkout).
	let restoreTarget: string | undefined = restoreBranch;

	const restore = async (): Promise<void> => {
		if (restoreTarget) await run(["checkout", restoreTarget]);
	};

	if (signal?.aborted) return cancelledRebase();

	if (upstreamRemote) {
		await run(fetchBranch ? ["fetch", upstreamRemote, fetchBranch] : ["fetch", upstreamRemote], signal);
	}
	if (signal?.aborted) return cancelledRebase();

	if (!restoreTarget) {
		const previousBranch = (
			await tracedExeca("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {reject: false, env})
		).stdout.trim();
		// A detached HEAD reports "HEAD"; restore to its commit instead.
		restoreTarget =
			previousBranch && previousBranch !== "HEAD"
				? previousBranch
				: (await tracedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false, env})).stdout.trim() ||
					undefined;
	}

	const checkout = await run(["checkout", branch], signal);
	if (checkout.exitCode !== 0) {
		return {ok: false, stage: "checkout", stderr: checkout.stderr};
	}

	const branchSha = (await tracedExeca("git", ["-C", dir, "rev-parse", "HEAD"], {reject: false, env})).stdout.trim();

	if (signal?.aborted) {
		await restore();
		return cancelledRebase();
	}

	const rebaseArgs = rebaseMerges
		? ["rebase", "--rebase-merges", "--update-refs", upstreamRef]
		: ["rebase", upstreamRef];
	const rebase = await run(rebaseArgs, signal);
	if (rebase.exitCode !== 0) {
		await run(["rebase", "--abort"]);
		if (signal?.aborted) {
			await restore();
			return cancelledRebase();
		}
		const upstreamSha = getCachedUpstreamSha(project);
		if (upstreamSha && branchSha) {
			cacheMergeStatus(project, branchSha, upstreamSha, 0, 1, false);
		}
		await restore();
		return {ok: false, stage: "rebase", stderr: rebase.stderr};
	}
	if (signal?.aborted) {
		await restore();
		return cancelledRebase();
	}

	const pushRemote =
		options.pushRemote ??
		((await tracedExeca("git", ["-C", dir, "config", `branch.${branch}.remote`], {reject: false})).stdout.trim() ||
			"origin");
	const push = await run(["push", pushRemote, `${branch}:${branch}`, "--force-with-lease"], signal);
	if (signal?.aborted) {
		await restore();
		return cancelledRebase();
	}
	if (push.exitCode !== 0 && !push.stderr.includes("Everything up-to-date")) {
		await restore();
		return {ok: false, stage: "push", stderr: push.stderr};
	}

	await restore();
	return {ok: true, message: `Rebased ${branch} onto ${upstreamRef}`};
}
