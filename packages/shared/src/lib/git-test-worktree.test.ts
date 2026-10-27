import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {execSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {ExecaResult} from "../services/traced-execa.js";

type Run = () => Promise<ExecaResult>;

/** Wrappers around the next `git rev-parse --git-common-dir` calls, so a test can reorder them. */
const {revParseHooks} = vi.hoisted(() => ({revParseHooks: [] as ((run: Run) => ReturnType<Run>)[]}));

vi.mock("../services/traced-execa.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../services/traced-execa.js")>();
	return {
		...original,
		tracedExeca: async (...args: Parameters<typeof original.tracedExeca>) => {
			const run = async () => original.tracedExeca(...args);
			const hook = args[1].includes("--git-common-dir") ? revParseHooks.shift() : undefined;
			return hook ? hook(run) : run();
		},
	};
});

import {gitTestRun} from "./git-test-cli.js";

function git(dir: string, command: string): string {
	return execSync(`git ${command}`, {cwd: dir, stdio: ["ignore", "pipe", "ignore"]})
		.toString()
		.trim();
}

/** HEAD, the HEAD reflog and `git status` together: anything a checkout would disturb. */
function checkoutState(dir: string): {head: string; reflog: string; status: string} {
	return {
		head: git(dir, "rev-parse HEAD"),
		reflog: git(dir, "reflog HEAD"),
		status: git(dir, "status --porcelain"),
	};
}

describe("gitTestRun never touches the user's checkout", () => {
	let dir: string;
	let worktree: string;
	let scratch: string;

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-test-worktree-")));
		worktree = `${dir}-test-worktree`;
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wip-test-worktree-scratch-"));
		git(dir, "init -b main");
		git(dir, "config user.email test@test.com");
		git(dir, "config user.name Test");
		fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
		git(dir, "add file.txt");
		git(dir, "commit -m base");
		fs.writeFileSync(path.join(dir, "file.txt"), "tip\n");
		git(dir, "commit -am tip");
		// Like the live incident: the user sits on a detached older commit, with work in progress.
		git(dir, "checkout --detach HEAD~1");
		fs.writeFileSync(path.join(dir, "file.txt"), "edited\n");
		fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");
	});

	afterEach(() => {
		if (fs.existsSync(worktree)) fs.rmSync(worktree, {recursive: true, force: true});
		fs.rmSync(dir, {recursive: true, force: true});
		fs.rmSync(scratch, {recursive: true, force: true});
	});

	it("runs in the sibling <repo>-test-worktree and leaves HEAD, reflog and working tree unchanged, even mid-run", async () => {
		const during = path.join(scratch, "during");
		// The test command snapshots the main checkout while the test is running, i.e. the state
		// an abort or a killed server would leave behind.
		git(dir, `test add --test default 'echo "$(git -C ${dir} rev-parse HEAD) $(pwd -P)" >> ${during}'`);
		const before = checkoutState(dir);
		const tip = git(dir, "rev-parse main");

		const result = await gitTestRun(dir, tip, {logDir: path.join(scratch, "logs")});

		expect({
			exitCode: result.exitCode,
			after: checkoutState(dir),
			during: fs.readFileSync(during, "utf8"),
			stored: git(dir, `test results --no-color ${tip}`).split(/\s+/)[0],
		}).toStrictEqual({
			exitCode: 0,
			after: before,
			during: `${before.head} ${worktree}\n`,
			stored: "good",
		});
	});

	it("reuses the existing test worktree and serializes concurrent runs in it", async () => {
		const ran = path.join(scratch, "ran");
		git(dir, `test add --test default 'git rev-parse HEAD >> ${ran}'`);
		const before = checkoutState(dir);
		const base = before.head;
		const tip = git(dir, "rev-parse main");

		const results = await Promise.all([
			gitTestRun(dir, base, {logDir: path.join(scratch, "logs")}),
			gitTestRun(dir, tip, {logDir: path.join(scratch, "logs")}),
		]);

		expect({
			exitCodes: results.map((r) => r.exitCode),
			ran: fs.readFileSync(ran, "utf8").split("\n").filter(Boolean),
			after: checkoutState(dir),
			worktrees: git(dir, "worktree list --porcelain")
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => fs.realpathSync(line.slice("worktree ".length))),
		}).toStrictEqual({
			exitCodes: [0, 0],
			ran: [base, tip],
			after: before,
			worktrees: [dir, worktree],
		});
	});

	it("runs concurrent calls in call order even when the first call's worktree lookup finishes last", async () => {
		const ran = path.join(scratch, "ran");
		git(dir, `test add --test default 'git rev-parse HEAD >> ${ran}'`);
		const base = git(dir, "rev-parse HEAD");
		const tip = git(dir, "rev-parse main");
		// The first call's lookup waits until the second call's lookup has returned, the order
		// a loaded machine can produce.
		let secondLookupDone!: () => void;
		const secondLookup = new Promise<void>((resolve) => {
			secondLookupDone = resolve;
		});
		revParseHooks.push(
			async (run) => {
				await secondLookup;
				return run();
			},
			async (run) => {
				const result = await run();
				secondLookupDone();
				return result;
			},
		);

		const results = await Promise.all([
			gitTestRun(dir, base, {logDir: path.join(scratch, "logs")}),
			gitTestRun(dir, tip, {logDir: path.join(scratch, "logs")}),
		]);

		expect({
			exitCodes: results.map((r) => r.exitCode),
			ran: fs.readFileSync(ran, "utf8").split("\n").filter(Boolean),
		}).toStrictEqual({
			exitCodes: [0, 0],
			ran: [base, tip],
		});
	});
});
