import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {z} from "zod";

/**
 * Read-only view of Claude Code's folder trust, so wip never launches a background agent that would
 * sit at the "Is this a project you created or one you trust?" prompt. wip never writes Claude's
 * config. Server-only.
 *
 * Mirrors Claude Code 2.1.x: a session is trusted when its git repo's canonical root (the main
 * checkout, also for a linked worktree) has `hasTrustDialogAccepted`, or any folder from the cwd up
 * to the cwd's own git root does. The walk stops at the git root, so trusting a folder above a
 * throwaway worktree (e.g. ~/.cache/wip/test-fix-worktrees) does not trust it; trusting the repo does.
 */

function isFile(file: string): boolean
{
	try
	{
		return fs.statSync(file).isFile();
	}
	catch
	{
		return false;
	}
}

/** Claude Code's global config: a legacy `.config.json` in its config dir if present, else `.claude.json`. */
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string
{
	const configDir = env.CLAUDE_CONFIG_DIR;
	const legacy = path.join(configDir ?? path.join(home, ".claude"), ".config.json");
	if (isFile(legacy)) return legacy;
	return path.join(configDir ?? home, ".claude.json");
}

/** The slice of Claude's global config wip reads: which folders' trust dialog was accepted. */
const ClaudeTrustConfigSchema = z.object(
	{
		projects: z
			.record(
				z.string(),
				z.object(
					{
						hasTrustDialogAccepted: z.unknown(),
					},
				),
			)
			.optional(),
	},
);

function readTrustedFolders(configPath: string): Set<string>
{
	try
	{
		const config = ClaudeTrustConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
		return new Set(
			Object.entries(config.projects ?? {})
				.filter(([, project]) => project.hasTrustDialogAccepted === true)
				.map(([dir]) => dir.normalize("NFC")),
		);
	}
	catch
	{
		return new Set();
	}
}

/** The nearest folder at or above `dir` holding a `.git` entry; null outside any repo. */
function gitRootOf(dir: string): string | null
{
	let current = dir;
	for (;;)
	{
		if (fs.existsSync(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** The main checkout of the repo whose root is `gitRoot`: itself, or for a linked worktree the folder holding the common .git dir. */
function canonicalRootOf(gitRoot: string): string
{
	const dotGit = path.join(gitRoot, ".git");
	if (!isFile(dotGit)) return gitRoot;
	const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
	if (!match?.[1]) return gitRoot;
	const gitDir = path.resolve(gitRoot, match[1].trim());
	const commonDirFile = path.join(gitDir, "commondir");
	if (!isFile(commonDirFile)) return gitRoot;
	const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, "utf8").trim());
	return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : gitRoot;
}

function realpath(dir: string): string
{
	try
	{
		return fs.realpathSync(dir);
	}
	catch
	{
		return path.resolve(dir);
	}
}

/**
 * The folder Claude must trust before an agent can start in a fresh throwaway worktree of the repo
 * holding `repoDir` (its main checkout), or null when Claude already trusts it. A fresh worktree
 * folder has no trust entry of its own, so only the main checkout's counts.
 */
export function untrustedWorktreeFolder(repoDir: string, configPath: string = claudeGlobalConfigPath()): string | null
{
	const real = realpath(repoDir);
	const gitRoot = gitRootOf(real);
	const folder = gitRoot === null ? real : canonicalRootOf(gitRoot);
	return readTrustedFolders(configPath).has(folder.normalize("NFC")) ? null : folder;
}

/** Projects whose last agent launch was skipped because Claude does not trust the folder, by project. */
const untrusted = new Map<string, string>();

/** Records a project's latest trust check before an agent launch: the folder to trust, or null when trusted. */
export function recordClaudeTrust(project: string, folder: string | null): void
{
	if (folder === null) untrusted.delete(project);
	else untrusted.set(project, folder);
}

/** Folders the user must trust in Claude so background fixes can run, by project. */
export function untrustedAgentFolders(): ReadonlyMap<string, string>
{
	return untrusted;
}
