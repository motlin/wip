import * as fs from "node:fs";
import * as path from "node:path";
import {z} from "zod";

import {log} from "../services/logger-pino.js";
import {tracedExeca} from "../services/traced-execa.js";
import {nameBranch} from "./branch-namer.js";
import {
	getTestResultsForProject,
	getBranchName,
	setBranchName,
	getCachedMiseEnv,
	cacheMiseEnv,
	getCachedUpstreamSha,
	cacheUpstreamSha,
} from "./db.js";
import {mapWithConcurrency} from "./concurrency.js";
import {git, parseRemoteUrl} from "./git-exec.js";
import {getCanonicalRepo, type PrStatuses} from "./github-pr-status.js";
import {type CheckStatus, type ChildCommit, type ProjectInfo, type ReviewStatus} from "./schemas.js";

const MiseEnvSchema = z.record(z.string(), z.string());

const SKIPPABLE_PATTERNS = ["[skip]", "[pass]", "[stop]", "[fail]"];

// Cap for repo-independent git fan-outs (project discovery).
const DISCOVERY_CONCURRENCY = 8;

export async function getMiseEnv(dir: string): Promise<Record<string, string>> {
	const cached = getCachedMiseEnv(dir);
	if (cached) return MiseEnvSchema.parse(cached);

	const start = performance.now();
	const result = await tracedExeca("mise", ["env", "-C", dir, "--json"], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "mise", args: ["env", "-C", dir, "--json"], duration},
		`mise env -C ${dir} --json (${duration}ms)`,
	);

	if (result.exitCode !== 0) return {};

	const env = MiseEnvSchema.parse(JSON.parse(result.stdout));
	cacheMiseEnv(dir, env);
	return env;
}

function parseEnvrc(dir: string): {upstreamRemote: string; upstreamBranch: string} {
	const envrcPath = path.join(dir, ".envrc");
	let upstreamRemote = "upstream";
	let upstreamBranch = "main";

	if (fs.existsSync(envrcPath)) {
		const content = fs.readFileSync(envrcPath, "utf-8");
		const remoteMatch = content.match(/^export UPSTREAM_REMOTE=(\S+)/m);
		const branchMatch = content.match(/^export UPSTREAM_BRANCH=(\S+)/m);
		if (remoteMatch?.[1]) upstreamRemote = remoteMatch[1];
		if (branchMatch?.[1]) upstreamBranch = branchMatch[1];
	}

	return {upstreamRemote, upstreamBranch};
}

export function isSkippable(message: string): boolean {
	return SKIPPABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function getPatchId(dir: string, sha: string): Promise<string> {
	const start = performance.now();
	const formatPatch = await tracedExeca("git", ["-C", dir, "diff-tree", "-p", sha], {
		reject: false,
	});
	if (formatPatch.exitCode !== 0 || !formatPatch.stdout) return "";
	const patchId = await tracedExeca("git", ["-C", dir, "patch-id", "--stable"], {
		input: formatPatch.stdout,
		reject: false,
	});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: "git", args: ["patch-id", sha], duration}, `git patch-id for ${sha} (${duration}ms)`);
	if (patchId.exitCode !== 0 || !patchId.stdout) return "";
	return patchId.stdout.trim().split(/\s+/)[0] ?? "";
}

/**
 * For a branchless commit, check if any remote branch tip has the same patch content.
 * Returns the remote branch name if found, undefined otherwise.
 */
async function findRemoteBranchByPatchId(
	dir: string,
	sha: string,
	remoteBranchRefs: Map<string, string>,
): Promise<string | undefined> {
	const commitPatchId = await getPatchId(dir, sha);
	if (!commitPatchId) return undefined;

	// Check remote branch tips in parallel (limited to avoid overwhelming git)
	const entries = Array.from(remoteBranchRefs.entries());
	const BATCH_SIZE = 10;
	for (let i = 0; i < entries.length; i += BATCH_SIZE) {
		const batch = entries.slice(i, i + BATCH_SIZE);
		const results = await Promise.all(
			batch.map(async ([branchName, refName]) => {
				const remoteSha = await git(dir, "rev-parse", refName);
				if (!remoteSha) return null;
				const remotePatchId = await getPatchId(dir, remoteSha);
				if (remotePatchId === commitPatchId) return branchName;
				return null;
			}),
		);
		const match = results.find((r) => r !== null);
		if (match) return match;
	}
	return undefined;
}

export async function isDirty(dir: string): Promise<boolean> {
	const diffStart = performance.now();
	const diffResult = await tracedExeca("git", ["-C", dir, "diff", "--quiet", "HEAD"], {
		reject: false,
	});
	const diffDuration = Math.round(performance.now() - diffStart);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, "diff", "--quiet", "HEAD"], duration: diffDuration},
		`git -C ${dir} diff --quiet HEAD (${diffDuration}ms)`,
	);
	if (diffResult.exitCode !== 0) return true;

	const untracked = await git(dir, "ls-files", "--others", "--exclude-standard");
	return untracked.length > 0;
}

export async function isDetachedHead(dir: string): Promise<boolean> {
	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, "symbolic-ref", "-q", "HEAD"], {
		reject: false,
	});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, "symbolic-ref", "-q", "HEAD"], duration},
		`git -C ${dir} symbolic-ref -q HEAD (${duration}ms)`,
	);
	return result.exitCode !== 0;
}

export async function hasUpstreamRef(dir: string, ref: string): Promise<boolean> {
	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, "rev-parse", "--verify", ref], {
		reject: false,
	});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, "rev-parse", "--verify", ref], duration},
		`git -C ${dir} rev-parse --verify ${ref} (${duration}ms)`,
	);
	return result.exitCode === 0;
}

export async function hasTestConfigured(dir: string): Promise<boolean> {
	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, "config", "--get-regexp", "^test\\."], {
		reject: false,
	});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, "config", "--get-regexp", "^test\\."], duration},
		`git -C ${dir} config --get-regexp ^test. (${duration}ms)`,
	);
	return result.exitCode === 0;
}

export async function getChildren(dir: string, upstreamRef: string): Promise<string[]> {
	const output = await git(dir, "children", upstreamRef);
	if (!output) return [];
	return output.split("\n").filter(Boolean);
}

export async function getNeedsRebaseBranches(
	dir: string,
	upstreamRef: string,
	projectName?: string,
	prStatuses?: PrStatuses,
	remoteBranches?: Set<string>,
	remoteBranchRefs?: Map<string, string>,
	mergeStatusMap?: Map<string, {commitsAhead: number; commitsBehind: number; rebaseable: boolean | null}>,
): Promise<ChildCommit[]> {
	// --no-contains does a full ancestry check, not just direct-parent matching.
	// Without this, multi-commit branches whose tip's parent is an intermediate
	// commit (not the upstream ref itself) would be incorrectly flagged.
	const noContainsOutput = await git(
		dir,
		"for-each-ref",
		"--format=%(refname:short)",
		`--no-contains=${upstreamRef}`,
		"refs/heads/",
	);
	if (!noContainsOutput) return [];

	const nonMainBranches = noContainsOutput
		.split("\n")
		.filter(Boolean)
		.filter((b) => !b.match(/^(main|master)$/));
	if (nonMainBranches.length === 0) return [];

	const testStatusMap: Map<string, "passed" | "failed"> = projectName
		? getTestResultsForProject(projectName)
		: new Map();

	const needsRebase: ChildCommit[] = [];
	const format = "%H%x00%h%x00%s%x00%B%x00%ai";

	for (const branch of nonMainBranches) {
		const logResult = await tracedExeca(
			"git",
			["-C", dir, "log", "-1", `--format=${format}`, `refs/heads/${branch}`],
			{
				reject: false,
			},
		);

		if (logResult.exitCode !== 0) continue;

		const fields = logResult.stdout.trim().split("\0");
		if (fields.length < 5) continue;

		const sha = fields[0] ?? "";
		const shortSha = fields[1] ?? "";
		const subject = fields[2] ?? "";
		const fullMessage = fields[3] ?? "";
		const rawDate = fields[4] ?? "";
		const date = rawDate.trim().split(" ")[0] ?? "";

		const pushedToRemote = remoteBranches ? remoteBranches.has(branch) : false;
		const reviewStatus = prStatuses ? (prStatuses.review.get(branch) ?? ("no_pr" as const)) : ("no_pr" as const);
		const checkStatus: CheckStatus = prStatuses ? (prStatuses.checks.get(branch) ?? "none") : "none";
		const prUrl = prStatuses ? prStatuses.urls.get(branch) : undefined;
		const prNumber = prStatuses ? prStatuses.prNumbers.get(branch) : undefined;
		const failedChecks = prStatuses ? prStatuses.failedChecks.get(branch) : undefined;
		const behind = prStatuses ? prStatuses.behind.get(branch) : undefined;
		const mergeStateStatus = prStatuses ? prStatuses.mergeStateStatuses.get(branch) : undefined;
		const ms = mergeStatusMap?.get(sha);

		let localAhead: boolean | undefined;
		if (pushedToRemote && remoteBranchRefs) {
			const remoteRef = remoteBranchRefs.get(branch);
			if (remoteRef) {
				const remoteSha = await git(dir, "rev-parse", remoteRef);
				localAhead = remoteSha !== "" && remoteSha !== sha;
			}
		}

		needsRebase.push({
			sha,
			shortSha,
			subject,
			date,
			branch,
			testStatus: testStatusMap.get(sha) ?? "unknown",
			checkStatus,
			skippable: isSkippable(fullMessage),
			pushedToRemote,
			localAhead,
			needsRebase: true,
			reviewStatus,
			prUrl,
			prNumber,
			failedChecks,
			behind,
			commitsBehind: ms?.commitsBehind,
			commitsAhead: ms?.commitsAhead,
			rebaseable: ms?.rebaseable ?? undefined,
			mergeStateStatus,
		});
	}

	return needsRebase;
}

export interface RemoteBranchInfo {
	remoteBranches: Set<string>;
	remoteBranchRefs: Map<string, string>;
	defaultBranch: string | undefined;
}

export function parseRemoteBranchOutput(output: string): RemoteBranchInfo {
	const remoteBranches = new Set<string>();
	const remoteBranchRefs = new Map<string, string>();
	let defaultBranch: string | undefined;
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const arrowIdx = trimmed.indexOf(" -> ");
		if (arrowIdx >= 0) {
			const target = trimmed.slice(arrowIdx + 4);
			const slashIdx = target.indexOf("/");
			if (slashIdx >= 0) defaultBranch = target.slice(slashIdx + 1);
			continue;
		}
		const slashIdx = trimmed.indexOf("/");
		if (slashIdx >= 0) {
			const branchName = trimmed.slice(slashIdx + 1);
			remoteBranches.add(branchName);
			remoteBranchRefs.set(branchName, trimmed);
		}
	}
	return {remoteBranches, remoteBranchRefs, defaultBranch};
}

export async function getRemoteBranchInfo(dir: string): Promise<RemoteBranchInfo> {
	const output = await git(dir, "branch", "-r");
	return parseRemoteBranchOutput(output);
}

/**
 * Remove tracking refs for branches that no longer exist on the named remote.
 * Without this, `git branch -r` keeps reporting branches that were deleted on
 * GitHub — making `pushedToRemote` a lie and breaking downstream classification
 * and branch-URL construction. Silent on remotes that can't be contacted.
 */
export async function pruneRemote(dir: string, remote: string): Promise<void> {
	await git(dir, "remote", "prune", remote);
}

export function parseBranch(decoration: string): string | undefined {
	const refs = decoration
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean);
	for (const ref of refs) {
		const branch = ref.replace(/^HEAD -> /, "");
		if (branch && branch !== "HEAD") return branch;
	}
	return undefined;
}

function parseContainingBranch(output: string, defaultBranch?: string): string | undefined {
	const excludedBranches = new Set(["main", "master"]);
	if (defaultBranch) excludedBranches.add(defaultBranch);

	const branches = output
		.split("\n")
		.map((line) => line.trim())
		.filter((branch) => branch && !excludedBranches.has(branch));
	return branches.length === 1 ? branches[0] : undefined;
}

async function findContainingBranch(dir: string, sha: string, defaultBranch?: string): Promise<string | undefined> {
	const output = await git(dir, "branch", "--format", "%(refname:short)", "--contains", sha);
	return parseContainingBranch(output, defaultBranch);
}

/**
 * Parse owner and repo name from a git remote URL.
 * Supports formats: git@host:owner/repo.git, https://host/owner/repo.git
 */
export async function getRepoOwnerAndName(dir: string): Promise<{owner: string; name: string}> {
	const remoteUrl = await git(dir, "remote", "get-url", "origin");
	const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match?.[1] || !match[2]) {
		throw new Error(`Could not parse owner/repo from remote URL: ${remoteUrl}`);
	}
	return {owner: match[1], name: match[2]};
}

export async function fetchUpstreamRef(
	dir: string,
	upstreamRef: string,
	projectName: string,
): Promise<{changed: boolean; sha: string}> {
	const parts = upstreamRef.split("/");
	const remote = parts[0] ?? "";
	const branch = parts.slice(1).join("/");
	const env = await getMiseEnv(dir);

	await tracedExeca("git", ["-C", dir, "fetch", remote, branch], {reject: false, env});

	const result = await git(dir, "rev-parse", upstreamRef);
	const newSha = result.trim();
	if (!newSha) return {changed: false, sha: ""};

	const cachedSha = getCachedUpstreamSha(projectName);
	if (cachedSha === newSha) return {changed: false, sha: newSha};

	cacheUpstreamSha(projectName, upstreamRef, newSha);
	return {changed: true, sha: newSha};
}

export async function computeMergeStatus(
	dir: string,
	sha: string,
	upstreamSha: string,
): Promise<{commitsAhead: number; commitsBehind: number; rebaseable: boolean | null}> {
	const behindResult = await git(dir, "rev-list", "--count", `${sha}..${upstreamSha}`);
	const aheadResult = await git(dir, "rev-list", "--count", `${upstreamSha}..${sha}`);
	const commitsBehind = parseInt(behindResult.trim(), 10) || 0;
	const commitsAhead = parseInt(aheadResult.trim(), 10) || 0;

	let rebaseable: boolean | null = null;
	if (commitsBehind > 0) {
		const mergeTree = await tracedExeca(
			"git",
			["-C", dir, "merge-tree", "--quiet", "--write-tree", upstreamSha, sha],
			{reject: false},
		);
		rebaseable = mergeTree.exitCode === 0;
	}

	return {commitsAhead, commitsBehind, rebaseable};
}

export async function getChildCommits(
	dir: string,
	upstreamRef: string,
	hasTest: boolean,
	prStatuses?: PrStatuses,
	projectName?: string,
	mergeStatusMap?: Map<string, {commitsAhead: number; commitsBehind: number; rebaseable: boolean | null}>,
): Promise<ChildCommit[]> {
	const childrenOutput = await git(dir, "children", upstreamRef);
	if (!childrenOutput) return [];

	const shas = childrenOutput.split("\n").filter(Boolean);

	const RS = "\x1e";

	const start = performance.now();
	const format = "%H%x00%h%x00%s%x00%B%x00%ai%x00%D%x00%ae%x1e";
	const [logResult, remoteBranchOutput, userEmail] = await Promise.all([
		tracedExeca(
			"git",
			["-C", dir, "log", "--stdin", "--no-walk", "--decorate-refs=refs/heads/", `--format=${format}`],
			{
				input: shas.join("\n"),
				reject: false,
			},
		),
		git(dir, "branch", "-r"),
		git(dir, "config", "user.email"),
	]);
	const logDuration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{
			cmd: "git",
			args: ["-C", dir, "log", "--stdin", "--no-walk", "--format=..."],
			duration: logDuration,
		},
		`git -C ${dir} log --stdin --no-walk --format=... (${logDuration}ms)`,
	);

	if (logResult.exitCode !== 0) return [];

	const {remoteBranches, remoteBranchRefs, defaultBranch} = parseRemoteBranchOutput(remoteBranchOutput);

	const testStatusMap: Map<string, "passed" | "failed"> =
		hasTest && projectName ? getTestResultsForProject(projectName) : new Map();

	const records = logResult.stdout.split(RS).filter((r) => r.trim());
	const children: ChildCommit[] = [];

	for (const record of records) {
		const trimmedRecord = record.replace(/^\n+/, "");
		const fields = trimmedRecord.split("\0");
		if (fields.length < 7) continue;

		const sha = fields[0] ?? "";
		const shortSha = fields[1] ?? "";
		const subject = fields[2] ?? "";
		const fullMessage = fields[3] ?? "";
		const rawDate = fields[4] ?? "";
		const decoration = fields[5] ?? "";
		const authorEmail = fields[6] ?? "";

		// Filter out commits from other authors (e.g. dependabot, renovate)
		if (userEmail && authorEmail.trim() !== userEmail) continue;
		const date = rawDate.trim().split(" ")[0] ?? "";
		const skippable = isSkippable(fullMessage);
		const branch = parseBranch(decoration);
		const testStatus = skippable ? "unknown" : (testStatusMap.get(sha) ?? "unknown");
		const reviewStatus: ReviewStatus = branch && prStatuses ? (prStatuses.review.get(branch) ?? "no_pr") : "no_pr";
		const checkStatus: CheckStatus = branch && prStatuses ? (prStatuses.checks.get(branch) ?? "none") : "none";
		const prUrl = branch && prStatuses ? prStatuses.urls.get(branch) : undefined;
		const pushedToRemote = branch ? remoteBranches.has(branch) : false;
		// Detect if local branch is ahead of remote tracking branch
		let localAhead: boolean | undefined;
		if (branch && pushedToRemote && branch !== defaultBranch) {
			const remoteRef = remoteBranchRefs.get(branch);
			if (remoteRef) {
				const remoteSha = await git(dir, "rev-parse", remoteRef);
				localAhead = remoteSha !== "" && remoteSha !== sha;
			}
		}

		const failedChecks = branch && prStatuses ? prStatuses.failedChecks.get(branch) : undefined;
		const behind = branch && prStatuses ? prStatuses.behind.get(branch) : undefined;
		const prNumber = branch && prStatuses ? prStatuses.prNumbers.get(branch) : undefined;
		const mergeStateStatus = branch && prStatuses ? prStatuses.mergeStateStatuses.get(branch) : undefined;

		// Merge status from cache (computed asynchronously by merge-queue)
		const ms = mergeStatusMap?.get(sha);
		const commitsBehind = ms?.commitsBehind;
		const commitsAhead = ms?.commitsAhead;
		const rebaseable = ms?.rebaseable ?? undefined;

		// For branchless commits, check if the same patch exists on a remote branch with a PR
		let alreadyOnRemote: {branch: string} | undefined;
		if (!branch && prStatuses && prStatuses.urls.size > 0) {
			// Only check remote branches that have open PRs (much smaller set)
			const prBranchRefs = new Map<string, string>();
			for (const prBranch of prStatuses.urls.keys()) {
				const ref = remoteBranchRefs.get(prBranch);
				if (ref) prBranchRefs.set(prBranch, ref);
			}
			if (prBranchRefs.size > 0) {
				const matchedBranch = await findRemoteBranchByPatchId(dir, sha, prBranchRefs);
				if (matchedBranch) alreadyOnRemote = {branch: matchedBranch};
			}
		}
		const containingBranch = branch ? undefined : await findContainingBranch(dir, sha, defaultBranch);

		children.push({
			sha,
			shortSha,
			subject,
			date,
			branch,
			testStatus,
			checkStatus,
			skippable,
			pushedToRemote,
			localAhead,
			reviewStatus,
			prUrl,
			prNumber,
			failedChecks,
			behind,
			commitsBehind,
			commitsAhead,
			rebaseable,
			mergeStateStatus,
			alreadyOnRemote,
			containingBranch,
		});
	}

	return children;
}

export async function createBranchForChild(dir: string, child: ChildCommit, project: string): Promise<string> {
	if (child.branch) return child.branch;

	const cached = getBranchName(child.sha, project);
	if (cached) {
		await tracedExeca("git", ["-C", dir, "branch", cached, child.sha], {reject: false});
		return cached;
	}

	const branchName = await nameBranch({sha: child.sha, project, subject: child.subject, dir});
	if (!branchName) {
		throw new Error(`Failed to generate branch name for ${child.shortSha} (${child.subject})`);
	}

	setBranchName(child.sha, project, branchName);
	await tracedExeca("git", ["-C", dir, "branch", branchName, child.sha], {reject: false});
	return branchName;
}

export async function testBranch(
	dir: string,
	branch: string,
	upstreamRef: string,
	env: Record<string, string>,
	opts?: {force?: boolean},
): Promise<{exitCode: number; logContent: string}> {
	// Write JUSTFILE_BRANCH as crash-recovery courtesy
	const branchFilePath = path.join(dir, "JUSTFILE_BRANCH");
	fs.writeFileSync(branchFilePath, branch + "\n");

	const testArgs = ["test", "run", "--retest"];
	if (opts?.force) testArgs.push("--force");
	testArgs.push(`${upstreamRef}..${branch}`);

	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, ...testArgs], {reject: false, env});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, ...testArgs], duration},
		`git -C ${dir} ${testArgs.join(" ")} (${duration}ms)`,
	);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join("\n");
	return {exitCode: result.exitCode ?? 1, logContent};
}

export async function hasLocalModifications(dir: string): Promise<boolean> {
	const diffResult = await tracedExeca("git", ["-C", dir, "diff", "--ignore-submodules", "--quiet"], {
		reject: false,
	});
	if (diffResult.exitCode !== 0) return true;

	const stagedResult = await tracedExeca("git", ["-C", dir, "diff", "--ignore-submodules", "--staged", "--quiet"], {
		reject: false,
	});
	if (stagedResult.exitCode !== 0) return true;

	const untrackedResult = await tracedExeca("git", ["-C", dir, "status", "--porcelain", "--ignore-submodules"], {
		reject: false,
	});
	if (untrackedResult.stdout.split("\n").some((line) => line.startsWith("??"))) return true;

	return false;
}

export async function testFix(
	dir: string,
	branch: string,
	upstreamRef: string,
	env: Record<string, string>,
	opts?: {force?: boolean},
): Promise<{ok: boolean; message: string}> {
	// 1. Stage modified tracked files
	await tracedExeca("git", ["-C", dir, "add", "--update"], {reject: false});

	// 2. Run pre-commit hooks on staged files (allow failure — hooks may auto-format)
	const cachedFiles = await tracedExeca("git", ["-C", dir, "diff", "--cached", "--name-only"], {
		reject: false,
	});
	if (cachedFiles.stdout.trim()) {
		const files = cachedFiles.stdout.trim().split("\n").join(" ");
		await tracedExeca("uv", ["tool", "run", "pre-commit", "run", "--files", ...files.split(" ")], {
			cwd: dir,
			reject: false,
			env,
		});
	}

	// 3. Re-stage after pre-commit modifications
	await tracedExeca("git", ["-C", dir, "add", "--update"], {reject: false});

	// 4. Create fixup commit
	const commitResult = await tracedExeca("git", ["-C", dir, "commit", "--quiet", "--fixup", "HEAD", "--no-verify"], {
		reject: false,
	});
	if (commitResult.exitCode !== 0) {
		return {ok: false, message: `fixup commit failed: ${commitResult.stderr}`};
	}

	// 5. Check for remaining dirty files
	if (await hasLocalModifications(dir)) {
		return {ok: false, message: "worktree still dirty after fixup commit"};
	}

	// 6. Autosquash rebase — squashes the fixup commit into its target and rebases onto upstream
	const autosquash = await tracedExeca(
		"git",
		["-C", dir, "rebase", "--autosquash", "--rebase-merges", "--update-refs", upstreamRef],
		{reject: false, env: {...env, GIT_SEQUENCE_EDITOR: "true"}},
	);
	if (autosquash.exitCode !== 0) {
		return {ok: false, message: `autosquash rebase failed: ${autosquash.stderr}`};
	}

	// 7. Clean up JUSTFILE_BRANCH
	const branchFilePath = path.join(dir, "JUSTFILE_BRANCH");
	if (fs.existsSync(branchFilePath)) fs.unlinkSync(branchFilePath);

	// 8. Re-run test on fixed branch
	const retest = await testBranch(dir, branch, upstreamRef, env, opts);
	if (retest.exitCode === 0) {
		return {ok: true, message: "fixed and retested successfully"};
	}

	return {ok: false, message: `retest failed after fix (exit ${retest.exitCode})`};
}

export async function discoverProjects(projectsDir: string): Promise<ProjectInfo[]> {
	const entries = fs.readdirSync(projectsDir, {withFileTypes: true});

	// Filter to git root repos (synchronous filesystem checks)
	const gitDirs: Array<{name: string; dir: string}> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(projectsDir, entry.name);
		const gitPath = path.join(dir, ".git");
		if (!fs.existsSync(gitPath)) continue;
		if (!fs.statSync(gitPath).isDirectory()) continue;
		gitDirs.push({name: entry.name, dir});
	}

	// Gather per-project info with bounded concurrency — each project's git calls
	// are independent, but an unbounded fan-out spawns hundreds of subprocesses
	// at once on a large projects dir.
	const results = await mapWithConcurrency(gitDirs, DISCOVERY_CONCURRENCY, async ({name, dir}) => {
		const {upstreamRemote, upstreamBranch} = parseEnvrc(dir);
		const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;

		if (!(await hasUpstreamRef(dir, upstreamRef))) return null;

		const [canonicalRepo, originUrl, dirtyFlag, detached, branchList, hasTest] = await Promise.all([
			getCanonicalRepo(dir, upstreamRemote),
			git(dir, "remote", "get-url", "origin"),
			isDirty(dir),
			isDetachedHead(dir),
			git(dir, "branch", "--list"),
			hasTestConfigured(dir),
		]);

		const ghRemote = `${canonicalRepo.owner}/${canonicalRepo.name}`;
		const originParsed = parseRemoteUrl(originUrl);
		const originRemote = originParsed ? `${originParsed.owner}/${originParsed.name}` : ghRemote;
		const branchCount = branchList
			.split("\n")
			.filter((b) => !b.trim().match(/^(\*?\s*)?(main|master)$/))
			.filter(Boolean).length;

		const rebaseInProgress =
			fs.existsSync(path.join(dir, ".git", "rebase-merge")) ||
			fs.existsSync(path.join(dir, ".git", "rebase-apply"));

		return {
			name,
			dir,
			remote: ghRemote,
			originRemote,
			upstreamRemote,
			upstreamBranch,
			upstreamRef,
			dirty: dirtyFlag,
			detachedHead: detached,
			branchCount,
			hasTestConfigured: hasTest,
			rebaseInProgress,
		} satisfies ProjectInfo;
	});

	return results.filter((p): p is ProjectInfo => p !== null);
}

export async function discoverAllProjects(projectsDirs: string[]): Promise<ProjectInfo[]> {
	const results = await Promise.all(projectsDirs.map((dir) => discoverProjects(dir)));
	return results.flat();
}
