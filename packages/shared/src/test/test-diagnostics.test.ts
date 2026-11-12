import {describe, it, expect, afterEach} from "vite-plus/test";
import {mkdirSync, mkdtempSync, readdirSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {sorted} from "./sorted.js";
import {
	diagnosticsVitestOptions,
	findTimeouts,
	parseSwapUsedMb,
	parseVmStat,
	pruneRuns,
	startSampler,
	summarizeWindow,
	type MachineSample,
} from "./test-diagnostics.js";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function sample(t: number, overrides: Partial<MachineSample> = {}): MachineSample {
	return {
		t,
		load1: 1,
		pageins: 100,
		swapins: 10,
		compressorPages: 1000,
		swapUsedMb: 500,
		pressureLevel: 1,
		backupd: false,
		...overrides,
	};
}

describe("parseVmStat", () => {
	it("reads pageins, swapins and compressor pages", () => {
		const text = [
			"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
			"Pages free:                                3779.",
			"Pages stored in compressor:             1812057.",
			"Pages occupied by compressor:            479936.",
			"Pageins:                              267867959.",
			"Swapins:                                3618028.",
			"Swapouts:                               6127265.",
		].join("\n");
		expect(parseVmStat(text)).toStrictEqual({pageins: 267867959, swapins: 3618028, compressorPages: 479936});
	});
});

describe("parseSwapUsedMb", () => {
	it("reads used megabytes from vm.swapusage", () => {
		expect(parseSwapUsedMb("total = 7168.00M  used = 6045.25M  free = 1122.75M  (encrypted)")).toBe(6045.25);
	});
});

describe("startSampler", () => {
	it("samples on each tick and stops when asked, waiting for the sample in flight", async () => {
		const seen: number[] = [];
		let calls = 0;
		const sampler = startSampler({
			intervalMs: 5,
			sample: async () => {
				calls += 1;
				return Promise.resolve(sample(calls));
			},
			onSample: (s) => seen.push(s.t),
		});
		await sleep(40);
		await sampler.stop();
		const countAtStop = seen.length;
		await sleep(30);

		expect(countAtStop).toBeGreaterThan(1);
		expect(seen.length).toBe(countAtStop);
		expect(seen).toStrictEqual(Array.from({length: countAtStop}, (_, i) => i + 1));
	});

	it("skips a tick while the previous sample is still running", async () => {
		let running = 0;
		let maxRunning = 0;
		const sampler = startSampler({
			intervalMs: 2,
			sample: async () => {
				running += 1;
				maxRunning = Math.max(maxRunning, running);
				await sleep(15);
				running -= 1;
				return sample(0);
			},
			onSample: () => {},
		});
		await sleep(40);
		await sampler.stop();
		expect(maxRunning).toBe(1);
	});
});

describe("findTimeouts", () => {
	it("places each timed-out test after the tests before it in its file", () => {
		const report = {
			testResults: [
				{
					name: "/repo/packages/web/src/a.test.ts",
					startTime: 10_000,
					endTime: 45_000,
					assertionResults: [
						{fullName: "a passes", status: "passed", duration: 2000, failureMessages: []},
						{
							fullName: "a hangs",
							status: "failed",
							duration: 30_000,
							failureMessages: ["Error: Test timed out in 30000ms.\n    at stack"],
						},
						{fullName: "a fails", status: "failed", duration: 5, failureMessages: ["AssertionError: nope"]},
					],
				},
				{
					name: "/repo/packages/web/src/b.test.ts",
					startTime: 10_000,
					endTime: 11_000,
					assertionResults: [{fullName: "b passes", status: "passed", duration: 3, failureMessages: []}],
				},
			],
		};
		expect(findTimeouts(report)).toStrictEqual([
			{file: "/repo/packages/web/src/a.test.ts", test: "a hangs", startMs: 12_000, endMs: 42_000},
		]);
	});
});

describe("summarizeWindow", () => {
	it("summarizes the samples in the window, padded, as one line", () => {
		const samples = [
			sample(0, {load1: 99}),
			sample(10_000, {load1: 33, pageins: 100, swapins: 10, compressorPages: 1000, swapUsedMb: 6000}),
			sample(20_000, {
				load1: 39,
				pageins: 900,
				swapins: 70,
				compressorPages: 1200,
				pressureLevel: 2,
				backupd: true,
				swapUsedMb: 6050,
			}),
			sample(30_000, {load1: 35, pageins: 950, swapins: 75, compressorPages: 1100, swapUsedMb: 6100}),
			sample(90_000, {load1: 99}),
		];
		expect(summarizeWindow(samples, 15_000, 25_000, 5000)).toBe(
			"3 samples: load 33-39, pageins +850, swapins +65, compressor pages 1000-1200, swap used 6000-6100M, pressure warn, backupd running",
		);
	});

	it("says so when no sample falls in the window", () => {
		expect(summarizeWindow([sample(0)], 50_000, 60_000, 5000)).toBe("no samples in window");
	});
});

describe("pruneRuns", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, {recursive: true, force: true});
		}
	});

	it("keeps only the newest runs", () => {
		const root = mkdtempSync(join(tmpdir(), "wip-test-diagnostics-"));
		tempDirs.push(root);
		for (const name of ["2001-01-01T00-00-01", "2001-01-01T00-00-03", "2001-01-01T00-00-02"]) {
			mkdirSync(join(root, name));
		}
		pruneRuns(root, 2);
		expect(sorted(readdirSync(root))).toStrictEqual(["2001-01-01T00-00-02", "2001-01-01T00-00-03"]);
	});
});

describe("diagnosticsVitestOptions", () => {
	it("adds a JSON report named for the package when a diagnostics dir is set", () => {
		expect(diagnosticsVitestOptions("web", {WIP_TEST_DIAGNOSTICS_DIR: "/diag"})).toStrictEqual({
			reporters: ["default", "json"],
			outputFile: {json: "/diag/web.json"},
		});
	});

	it("changes nothing otherwise", () => {
		expect(diagnosticsVitestOptions("web", {})).toStrictEqual({});
	});
});
