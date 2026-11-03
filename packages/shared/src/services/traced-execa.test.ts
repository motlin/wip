import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import {describe, it, expect} from "vite-plus/test";

import {SUBPROCESS_LIMIT} from "./subprocess-gate.js";
import {
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
