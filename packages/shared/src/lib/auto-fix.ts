import {tracedExeca} from "../services/traced-execa.js";

/**
 * The ready buffer's AI test fix (lean plan step 31) lands as a separate `fixup!` commit on top of
 * the failing commit, shown as "auto-fixed: <failure>" until the user accepts it. Accepting folds
 * the fixup into the original with plain git plumbing: no checkout, no worktree.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const FAILURE_LINE_RE = /FAIL|Error|error\[|AssertionError|✕|not ok|panicked|Exception/;
const MAX_SUMMARY = 120;

/** The failure the marker names: the log's last failure line, without colours, at most 120 characters. */
export function failureSummary(log: string): string {
	let line = "test failed";
	for (const raw of log.split("\n")) {
		const clean = raw.replace(ANSI_RE, "").trim();
		if (FAILURE_LINE_RE.test(clean)) line = clean;
	}
	return line.slice(0, MAX_SUMMARY);
}

async function git(dir: string, args: string[], input?: string) {
	return tracedExeca("git", ["-C", dir, ...args], input === undefined ? {reject: false} : {reject: false, input});
}

/**
 * Folds `fixupSha` into `originalSha` on `branch`: a new commit with the fixup's tree, the
 * original's parent, message and author. Moves the branch only while it still points at the
 * fixup. Null (branch untouched) when the fixup is not directly on the original or the branch moved.
 */
export async function squashFixup(
	dir: string,
	branch: string,
	originalSha: string,
	fixupSha: string,
): Promise<string | null> {
	const parent = await git(dir, ["rev-parse", `${fixupSha}^`]);
	if (parent.exitCode !== 0 || parent.stdout.trim() !== originalSha) return null;
	const info = await git(dir, ["log", "-1", "--format=%an%x00%ae%x00%ad%x00%B", originalSha]);
	if (info.exitCode !== 0) return null;
	const [name = "", email = "", date = "", ...message] = info.stdout.split("\0");
	const base = await git(dir, ["rev-parse", `${originalSha}^`]);
	if (base.exitCode !== 0) return null;
	const created = await tracedExeca(
		"git",
		["-C", dir, "commit-tree", `${fixupSha}^{tree}`, "-p", base.stdout.trim(), "-F", "-"],
		{
			reject: false,
			input: message.join("\0"),
			env: {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date},
		},
	);
	if (created.exitCode !== 0) return null;
	const squashed = created.stdout.trim();
	const update = await git(dir, ["update-ref", `refs/heads/${branch}`, squashed, fixupSha]);
	return update.exitCode === 0 ? squashed : null;
}
