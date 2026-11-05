import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import {describe, it, expect} from "vite-plus/test";

import {captureLogs} from "./logger.js";
import {SUBPROCESS_LIMIT} from "./subprocess-gate.js";
import {
	isExpectedProbeExit,
	subscribeSubprocessFailures,
	tracedExeca,
	unsubscribeSubprocessFailures,
	type SubprocessFailure,
} from "./traced-execa.js";

describe("tracedExeca global subprocess cap", () => {
	it("never runs more than SUBPROCESS_LIMIT children at once, however many callers fire together", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-subprocess-cap-"));
		const live = path.join(dir, "live");
		fs.mkdirSync(live);
		const observed = path.join(dir, "observed.txt");
		// Each child marks itself live, records how many children are live right now, then lingers.
		// A child only counts processes that are still running, so the recorded peak never exceeds the real one.
		const script = `touch "${live}/$$"; ls "${live}" | wc -l >> "${observed}"; sleep 0.3; rm "${live}/$$"`;

		const callers = 4 * SUBPROCESS_LIMIT;
		const results = await Promise.all(
			Array.from({length: callers}, async () => tracedExeca("sh", ["-c", script], {reject: false})),
		);

		const counts = fs
			.readFileSync(observed, "utf8")
			.trim()
			.split("\n")
			.map((line) => Number(line.trim()));
		fs.rmSync(dir, {recursive: true, force: true});

		expect({
			exitCodes: results.map((r) => r.exitCode),
			samples: counts.length,
			peakWithinCap: Math.max(...counts) <= SUBPROCESS_LIMIT,
		}).toStrictEqual({
			exitCodes: Array.from({length: callers}, () => 0),
			samples: callers,
			peakWithinCap: true,
		});
	});
});

describe("tracedExeca exit codes", () => {
	it("reports 0 for a successful command", async () => {
		const result = await tracedExeca("true", [], {reject: false});
		expect(result.exitCode).toBe(0);
		expect(result.failed).toBe(false);
	});

	it("reports the real non-zero exit code", async () => {
		const result = await tracedExeca("sh", ["-c", "exit 3"], {reject: false});
		expect(result.exitCode).toBe(3);
		expect(result.failed).toBe(true);
	});

	it("reports non-zero for a timed-out process", async () => {
		const result = await tracedExeca("sleep", ["5"], {reject: false, timeout: 50});
		expect(result.exitCode).not.toBe(0);
		expect(result.failed).toBe(true);
	});

	it("reports non-zero for a cancelled process", async () => {
		const controller = new AbortController();
		const promise = tracedExeca("sleep", ["5"], {reject: false, cancelSignal: controller.signal});
		setTimeout(() => {
			controller.abort();
		}, 50);
		const result = await promise;
		expect(result.exitCode).not.toBe(0);
		expect(result.failed).toBe(true);
	});
});

describe("tracedExeca killTreeOn", () => {
	it("kills the whole process tree, grandchildren included, when the signal aborts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-kill-tree-"));
		const pidFile = path.join(dir, "grandchild.pid");
		// The child starts a grandchild (the sleep), records its pid, and waits on it.
		const script = `sleep 30 & echo $! > "${pidFile}"; wait`;
		const controller = new AbortController();
		const started = Date.now();
		const run = tracedExeca("sh", ["-c", script], {reject: false}, {killTreeOn: controller.signal});
		while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
			// eslint-disable-next-line no-await-in-loop
			await new Promise((resolve) => {
				setTimeout(resolve, 20);
			});
		}
		const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
		controller.abort();
		const result = await run;
		await new Promise((resolve) => {
			setTimeout(resolve, 100);
		});
		let grandchildAlive = true;
		try {
			process.kill(grandchild, 0);
		} catch {
			grandchildAlive = false;
		}
		fs.rmSync(dir, {recursive: true, force: true});

		expect({
			failed: result.failed,
			quick: Date.now() - started < 10_000,
			grandchildAlive,
		}).toStrictEqual({failed: true, quick: true, grandchildAlive: false});
	});
});

// Runs tracedExeca with an un-aborted killTreeOn in a separate Node process (native type stripping,
// with .js specifiers resolved to their .ts sources), so the test can signal that process like a
// process manager stopping the server.
const SERVER_SCRIPT = `
import {registerHooks} from "node:module";
import * as fs from "node:fs";
registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
			throw error;
		}
	},
});
const [modulePath, pidFile] = process.argv.slice(2);
const {tracedExeca} = await import(modulePath);
void tracedExeca("sh", ["-c", \`sleep 30 & echo $! > "\${pidFile}"; wait\`], {reject: false}, {killTreeOn: new AbortController().signal});
setInterval(() => {}, 1000);
`;

describe("tracedExeca detached process groups on server shutdown", () => {
	it.each(["SIGTERM", "SIGINT"] as const)(
		"kills a running group when the server gets %s, and the server still exits",
		async (signal) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-orphan-group-"));
			const pidFile = path.join(dir, "grandchild.pid");
			const scriptFile = path.join(dir, "server.mjs");
			fs.writeFileSync(scriptFile, SERVER_SCRIPT);
			const modulePath = url.fileURLToPath(new URL("traced-execa.ts", import.meta.url));
			const server = childProcess.spawn(process.execPath, [scriptFile, modulePath, pidFile], {
				stdio: "ignore",
			});
			const exited = new Promise<number | null>((resolve) => {
				server.on("exit", (code) => {
					resolve(code);
				});
			});
			while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => {
					setTimeout(resolve, 20);
				});
			}
			const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
			server.kill(signal);
			const exitCode = await exited;
			await new Promise((resolve) => {
				setTimeout(resolve, 200);
			});
			let grandchildAlive = true;
			try {
				process.kill(grandchild, 0);
			} catch {
				grandchildAlive = false;
			}
			if (grandchildAlive) process.kill(grandchild, "SIGKILL");
			fs.rmSync(dir, {recursive: true, force: true});

			expect({exitCode, grandchildAlive}).toStrictEqual({
				exitCode: 128 + {SIGTERM: 15, SIGINT: 2}[signal],
				grandchildAlive: false,
			});
		},
		20_000,
	);
});

describe("tracedExeca failure listeners", () => {
	it("reports each failing subprocess's command, exit code and stderr, whether or not it rejects", async () => {
		const failures: SubprocessFailure[] = [];
		const listener = (failure: SubprocessFailure): void => {
			failures.push(failure);
		};
		subscribeSubprocessFailures(listener);
		try {
			await tracedExeca("sh", ["-c", "exit 0"], {reject: false});
			await tracedExeca("sh", ["-c", "echo boom >&2; exit 3"], {reject: false});
			await tracedExeca("sh", ["-c", "echo bang >&2; exit 4"]).catch(() => undefined);
		} finally {
			unsubscribeSubprocessFailures(listener);
		}
		await tracedExeca("sh", ["-c", "exit 5"], {reject: false});
		expect(failures).toStrictEqual([
			{command: "sh -c 'echo boom >&2; exit 3'", exitCode: 3, stderr: "boom"},
			{command: "sh -c 'echo bang >&2; exit 4'", exitCode: 4, stderr: "bang"},
		]);
	});
});

describe("isExpectedProbeExit", () => {
	it("knows the git probes whose non-zero exit is an answer, not a failure", () => {
		const cases: [string[], number][] = [
			[["-C", "/r", "merge-base", "--is-ancestor", "a", "b"], 1],
			[["-C", "/r", "merge-base", "--is-ancestor", "a", "b"], 128],
			[["-C", "/r", "rev-parse", "--verify", "--quiet", "refs/heads/x"], 1],
			[["-C", "/r", "rev-parse", "--verify", "x^{commit}"], 128],
			[["-C", "/r", "rev-parse", "HEAD"], 128],
			[["-C", "/r", "show-ref", "--verify", "--quiet", "refs/heads/x"], 1],
			[["-C", "/r", "diff", "--cached", "--quiet"], 1],
			[["-C", "/r", "diff", "--quiet", "HEAD"], 128],
			[["-C", "/r", "symbolic-ref", "--quiet", "--short", "HEAD"], 1],
			[["-C", "/r", "merge-tree", "--quiet", "--write-tree", "a", "b"], 1],
			[["-C", "/r", "config", "--get", "branch.x.remote"], 1],
			[["-C", "/r", "ls-remote", "--exit-code", "origin", "x"], 2],
			[["-C", "/r", "push", "upstream", "main"], 1],
			[["-c", "core.quotePath=false", "-C", "/r", "cat-file", "-e", "abc"], 1],
		];
		expect(
			cases.map(([args, exitCode]) => [args.join(" "), exitCode, isExpectedProbeExit("git", args, exitCode)]),
		).toStrictEqual([
			["-C /r merge-base --is-ancestor a b", 1, true],
			["-C /r merge-base --is-ancestor a b", 128, false],
			["-C /r rev-parse --verify --quiet refs/heads/x", 1, true],
			["-C /r rev-parse --verify x^{commit}", 128, true],
			["-C /r rev-parse HEAD", 128, false],
			["-C /r show-ref --verify --quiet refs/heads/x", 1, true],
			["-C /r diff --cached --quiet", 1, true],
			["-C /r diff --quiet HEAD", 128, false],
			["-C /r symbolic-ref --quiet --short HEAD", 1, true],
			["-C /r merge-tree --quiet --write-tree a b", 1, true],
			["-C /r config --get branch.x.remote", 1, true],
			["-C /r ls-remote --exit-code origin x", 2, true],
			["-C /r push upstream main", 1, false],
			["-c core.quotePath=false -C /r cat-file -e abc", 1, true],
		]);
		expect(isExpectedProbeExit("sh", ["-c", "exit 1"], 1)).toBe(false);
	});

	it("never reports a probe's expected exit as a failing subprocess", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-probe-"));
		childProcess.execFileSync("git", ["init", "--quiet", dir]);
		const failures: SubprocessFailure[] = [];
		const listener = (failure: SubprocessFailure): void => {
			failures.push(failure);
		};
		subscribeSubprocessFailures(listener);
		try {
			await tracedExeca("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "refs/heads/nope"], {
				reject: false,
			});
			await tracedExeca("git", ["-C", dir, "config", "--get", "no.such"], {reject: false});
			await tracedExeca("git", ["-C", dir, "merge-base", "--is-ancestor", "nope", "HEAD"], {reject: false});
		} finally {
			unsubscribeSubprocessFailures(listener);
		}
		expect(failures.map((f) => [f.command, f.exitCode])).toStrictEqual([
			[`git -C ${dir} merge-base --is-ancestor nope HEAD`, 128],
		]);
	});
});

async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const saved = process.env["WIP_SUBPROCESS_LOGGING"];
	process.env["WIP_SUBPROCESS_LOGGING"] = "true";
	try {
		const {logs} = await captureLogs(run, {categories: ["subprocess"]});
		return logs.map(({time, duration, ...rest}) =>
			Object.assign(rest, {time: typeof time, duration: typeof duration}),
		);
	} finally {
		if (saved === undefined) delete process.env["WIP_SUBPROCESS_LOGGING"];
		else process.env["WIP_SUBPROCESS_LOGGING"] = saved;
	}
}

describe("tracedExeca subprocess log", () => {
	it("logs every subprocess with its command, cwd and exit code, and stderr when it fails", async () => {
		const script = "process.stderr.write('remote rejected'); process.exit(3)";
		const logs = await logged(async () => {
			await tracedExeca("node", ["-e", "process.stdout.write('ok')"], {reject: false, cwd: os.tmpdir()});
			await tracedExeca("node", ["-e", script], {reject: false});
		});
		expect(logs).toStrictEqual([
			{
				level: 20,
				category: "subprocess",
				cmd: "node",
				args: ["-e", "process.stdout.write('ok')"],
				cwd: os.tmpdir(),
				exitCode: 0,
				msg: "node -e process.stdout.write('ok')",
				time: "number",
				duration: "number",
			},
			{
				level: 30,
				category: "subprocess",
				cmd: "node",
				args: ["-e", script],
				exitCode: 3,
				stderr: "remote rejected",
				msg: `node -e ${script} exited 3`,
				time: "number",
				duration: "number",
			},
		]);
	});

	it("logs a subprocess that throws", async () => {
		const logs = await logged(async () => tracedExeca("node", ["-e", "process.exit(2)"]).catch(() => undefined));
		expect(logs).toStrictEqual([
			{
				level: 30,
				category: "subprocess",
				cmd: "node",
				args: ["-e", "process.exit(2)"],
				exitCode: 2,
				stderr: "",
				msg: "node -e process.exit(2) exited 2",
				time: "number",
				duration: "number",
			},
		]);
	});
});
