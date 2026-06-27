import {tracedExeca} from "../services/traced-execa.js";
import {getMiseEnv} from "./git.js";
import {recordTestResult} from "./db.js";

/**
 * Broken-upstream detection. Before advancing branches, the baseline
 * (UPSTREAM_REMOTE/UPSTREAM_BRANCH) is tested: if it is itself red, the failure
 * is in the shared base, not the branches. The caller then fixes the baseline on
 * a local base commit and rebases every branch onto it.
 */

export interface BaselineCheck {
	sha: string;
	green: boolean;
}

/** Run git-test on a single commit, recording the result. */
async function defaultRunTest(dir: string, sha: string, project: string): Promise<boolean> {
	const env = await getMiseEnv(dir);
	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, "test", "run", "--retest", sha], {
		reject: false,
		env,
	});
	const duration = Math.round(performance.now() - start);
	const green = result.exitCode === 0;
	recordTestResult(sha, project, green ? "passed" : "failed", result.exitCode, duration);
	return green;
}

export async function checkBaseline(opts: {
	project: string;
	dir: string;
	upstreamRef: string;
	runTest?: (sha: string) => Promise<boolean>;
}): Promise<BaselineCheck> {
	const {project, dir, upstreamRef} = opts;
	const revParse = await tracedExeca("git", ["-C", dir, "rev-parse", upstreamRef], {
		reject: false,
	});
	const sha = revParse.stdout.trim();
	const runTest = opts.runTest ?? ((s: string) => defaultRunTest(dir, s, project));
	const green = await runTest(sha);
	return {sha, green};
}
