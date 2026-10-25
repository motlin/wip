import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {describe, it, expect} from "vite-plus/test";

import {SUBPROCESS_LIMIT} from "./subprocess-gate.js";
import {tracedExeca} from "./traced-execa.js";

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
