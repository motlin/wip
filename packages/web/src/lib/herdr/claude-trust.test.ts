import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {execSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import
{
	claudeGlobalConfigPath,
	recordClaudeTrust,
	untrustedAgentFolders,
	untrustedWorktreeFolder,
} from "./claude-trust.js";

function git(dir: string, args: string): string
{
	return execSync(
		`git ${args}`,
		{
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

function writeConfig(file: string, trusted: string[]): void
{
	fs.mkdirSync(
		path.dirname(file),
		{
			recursive: true,
		},
	);
	const projects = Object.fromEntries(
		trusted.map((dir) => [
			dir,
			{
				hasTrustDialogAccepted: true,
			},
		]),
	);
	fs.writeFileSync(
		file,
		JSON.stringify(
			{
				projects,
			},
		),
	);
}

describe("claudeGlobalConfigPath", () =>
{
	let home: string;

	beforeEach(() =>
	{
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-claude-home-")));
	});

	afterEach(() =>
	{
		fs.rmSync(
			home,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("reads ~/.claude.json, $CLAUDE_CONFIG_DIR/.claude.json when set, and a legacy .config.json in the config dir first", () =>
	{
		const configDir = path.join(home, "custom");
		const plain = claudeGlobalConfigPath(
			{
				HOME: home,
			},
			home,
		);
		const custom = claudeGlobalConfigPath(
			{
				HOME: home,
				CLAUDE_CONFIG_DIR: configDir,
			},
			home,
		);
		writeConfig(path.join(home, ".claude", ".config.json"), []);
		const legacy = claudeGlobalConfigPath(
			{
				HOME: home,
			},
			home,
		);
		expect(
			{
				plain,
				custom,
				legacy,
			},
		).toStrictEqual(
			{
				plain: path.join(home, ".claude.json"),
				custom: path.join(configDir, ".claude.json"),
				legacy: path.join(home, ".claude", ".config.json"),
			},
		);
	});
});

describe("untrustedWorktreeFolder", () =>
{
	let root: string;
	let repo: string;
	let config: string;

	beforeEach(() =>
	{
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-claude-trust-")));
		repo = path.join(root, "repo");
		fs.mkdirSync(
			path.join(repo, "nested"),
			{
				recursive: true,
			},
		);
		git(repo, "init -q -b main");
		git(repo, "-c user.email=t@t -c user.name=T commit -q --allow-empty -m base");
		config = path.join(root, "claude", ".claude.json");
	});

	afterEach(() =>
	{
		fs.rmSync(
			root,
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("trusts a throwaway worktree only through its repo's main checkout, never through a folder above the worktree", () =>
	{
		const worktrees = path.join(root, "test-fix-worktrees");
		writeConfig(config, [worktrees, root]);
		const aboveOnly = untrustedWorktreeFolder(path.join(repo, "nested"), config);
		writeConfig(config, [repo]);
		const repoTrusted = untrustedWorktreeFolder(path.join(repo, "nested"), config);
		fs.rmSync(config);
		const noConfig = untrustedWorktreeFolder(repo, config);
		expect(
			{
				aboveOnly,
				repoTrusted,
				noConfig,
			},
		).toStrictEqual(
			{
				aboveOnly: repo,
				repoTrusted: null,
				noConfig: repo,
			},
		);
	});

	it("resolves a linked worktree's repo to its main checkout", () =>
	{
		const linked = path.join(root, "linked");
		git(repo, `worktree add -q ${linked} -b side`);
		writeConfig(config, [repo]);
		const trusted = untrustedWorktreeFolder(linked, config);
		writeConfig(config, [linked]);
		const linkedOnly = untrustedWorktreeFolder(linked, config);
		expect(
			{
				trusted,
				linkedOnly,
			},
		).toStrictEqual(
			{
				trusted: null,
				linkedOnly: repo,
			},
		);
	});
});

describe("untrustedAgentFolders", () =>
{
	it("keeps the latest trust check per project and forgets a project once it is trusted", () =>
	{
		recordClaudeTrust("a", "/repos/a");
		recordClaudeTrust("b", "/repos/b");
		recordClaudeTrust("b", null);
		expect([...untrustedAgentFolders()]).toStrictEqual([["a", "/repos/a"]]);
		recordClaudeTrust("a", null);
	});
});
