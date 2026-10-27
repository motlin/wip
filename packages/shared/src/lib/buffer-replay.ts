import {replayOnto} from "./landing-detector.js";
import {tracedExeca} from "../services/traced-execa.js";

/**
 * Replays `branch` (expected at `expectedSha`) onto `onto` with `git replay`: no checkout, no
 * worktree, no new branch. Moves the branch only if it still points at `expectedSha`. Returns the
 * new tip, or null on a conflict or when the branch moved; the branch is then left alone.
 */
export async function replayBranchOnto(
	dir: string,
	branch: string,
	expectedSha: string,
	onto: string,
): Promise<string | null> {
	const newTip = await replayOnto(dir, expectedSha, onto);
	if (newTip === null) return null;
	const update = await tracedExeca("git", ["-C", dir, "update-ref", `refs/heads/${branch}`, newTip, expectedSha], {
		reject: false,
	});
	return update.exitCode === 0 ? newTip : null;
}
