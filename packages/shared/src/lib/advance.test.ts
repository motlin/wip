import {describe, it, expect, vi} from "vite-plus/test";

import {sorted} from "../test/sorted.js";

import {advanceProject, type AdvanceActions} from "./advance.js";
import {type AdvancePlan, type AdvanceUnit} from "./advance-plan.js";

const idleProbe = {loadPerCore: () => 0, freeMemRatio: () => 1};

function unit(id: string, dependsOn: string[] = []): AdvanceUnit {
	return {
		id,
		project: "proj",
		branch: id,
		tipSha: `sha-${id}`,
		chain: [`sha-${id}`],
		dependsOn,
		worktreeRequired: false,
	};
}

function plan(...units: AdvanceUnit[]): AdvancePlan {
	return {
		project: "proj",
		upstreamRef: "upstream/main",
		units,
		baseline: {sha: "base", needsTest: false},
	};
}

function planNeedsBaseline(...units: AdvanceUnit[]): AdvancePlan {
	return {...plan(...units), baseline: {sha: "base", needsTest: true}};
}

const okRebase = {ok: true, conflict: false, log: ""};

function actions(overrides: Partial<AdvanceActions> = {}): AdvanceActions {
	return {
		rebase: vi.fn<AdvanceActions["rebase"]>().mockResolvedValue(okRebase),
		test: vi.fn<AdvanceActions["test"]>().mockResolvedValue({green: true, log: ""}),
		resolveConflicts: vi.fn<AdvanceActions["resolveConflicts"]>().mockResolvedValue({ok: true, log: ""}),
		fix: vi.fn<AdvanceActions["fix"]>().mockResolvedValue({changed: true, log: ""}),
		absorb: vi.fn<AdvanceActions["absorb"]>().mockResolvedValue({ok: true, log: ""}),
		cleanup: vi.fn<AdvanceActions["cleanup"]>().mockResolvedValue(undefined),
		prepareBaseline: vi.fn<AdvanceActions["prepareBaseline"]>().mockResolvedValue("green"),
		...overrides,
	};
}

const opts = {probe: idleProbe, globalConcurrency: 4} as const;

describe("advanceProject", () => {
	it("reports green when every branch passes its first test", async () => {
		const report = await advanceProject(plan(unit("a"), unit("b")), actions(), opts);
		expect(report.status).toBe("green");
		expect(report.children.map((c) => [c.label, c.status])).toStrictEqual([
			["a", "green"],
			["b", "green"],
		]);
	});

	it("fixes a failing branch and goes green after absorb", async () => {
		const test = vi
			.fn<AdvanceActions["test"]>()
			.mockResolvedValueOnce({green: false, log: "FAIL Foo.bar"})
			.mockResolvedValue({green: true, log: ""});
		const report = await advanceProject(plan(unit("a")), actions({test}), opts);
		expect(report.children[0]?.status).toBe("green");
		expect(test).toHaveBeenCalledTimes(2); // failed once, fixed, passed
	});

	it("marks a branch stuck when the same failure recurs after a fix", async () => {
		const report = await advanceProject(
			plan(unit("a")),
			actions({
				test: vi
					.fn<AdvanceActions["test"]>()
					.mockResolvedValue({green: false, log: "FAIL Foo.bar\nAssertionError: 1 != 2"}),
			}),
			opts,
		);
		expect(report.children[0]?.status).toBe("stuck");
		expect(report.status).toBe("red");
	});

	it("does not fix in dry-run, reporting the failing branch red", async () => {
		const report = await advanceProject(
			plan(unit("a")),
			actions({test: vi.fn<AdvanceActions["test"]>().mockResolvedValue({green: false, log: "FAIL x"})}),
			{...opts, autonomy: "dry-run"},
		);
		expect(report.children[0]?.status).toBe("red");
	});

	it("resolves conflicts then continues to test", async () => {
		const resolveConflicts = vi.fn<AdvanceActions["resolveConflicts"]>().mockResolvedValue({ok: true, log: ""});
		const report = await advanceProject(
			plan(unit("a")),
			actions({
				rebase: vi
					.fn<AdvanceActions["rebase"]>()
					.mockResolvedValue({ok: false, conflict: true, log: "CONFLICT in App.tsx"}),
				resolveConflicts,
			}),
			opts,
		);
		expect(resolveConflicts).toHaveBeenCalledTimes(1);
		expect(report.children[0]?.status).toBe("green");
	});

	it("cascade-skips a dependent when its dependency fails", async () => {
		const report = await advanceProject(
			plan(unit("a"), unit("b", ["a"])),
			actions({
				// a fails and its fix changes nothing, so a gets stuck and b (which depends on a) is never tested
				test: vi.fn<AdvanceActions["test"]>().mockResolvedValue({green: false, log: "FAIL a"}),
				fix: vi.fn<AdvanceActions["fix"]>().mockResolvedValue({changed: false, log: ""}),
			}),
			opts,
		);
		const byBranch = Object.fromEntries(report.children.map((c) => [c.label, c.status]));
		expect(byBranch["a"]).toBe("stuck");
		expect(byBranch["b"]).toBe("skipped");
	});

	it("cleans up every unit when the run finishes green", async () => {
		const cleanup = vi.fn<AdvanceActions["cleanup"]>().mockResolvedValue(undefined);
		await advanceProject(plan(unit("a"), unit("b")), actions({cleanup}), opts);
		expect(sorted(cleanup.mock.calls.map(([u]) => u.id))).toStrictEqual(["a", "b"]);
	});

	it("cleans up a unit even when it gets stuck", async () => {
		const cleanup = vi.fn<AdvanceActions["cleanup"]>().mockResolvedValue(undefined);
		await advanceProject(
			plan(unit("a")),
			actions({
				test: vi.fn<AdvanceActions["test"]>().mockResolvedValue({green: false, log: "FAIL Foo.bar"}),
				fix: vi.fn<AdvanceActions["fix"]>().mockResolvedValue({changed: false, log: ""}),
				cleanup,
			}),
			opts,
		);
		expect(cleanup.mock.calls.map(([u]) => u.id)).toStrictEqual(["a"]);
	});

	it("marks the project upstream_fixed when the baseline was repaired", async () => {
		const report = await advanceProject(
			planNeedsBaseline(unit("a"), unit("b")),
			actions({prepareBaseline: vi.fn<AdvanceActions["prepareBaseline"]>().mockResolvedValue("fixed")}),
			opts,
		);
		expect(report.status).toBe("upstream_fixed");
		expect(report.children.map((c) => c.status)).toStrictEqual(["green", "green"]);
	});

	it("skips every unit and reports red when the baseline is broken and unfixable", async () => {
		const test = vi.fn<AdvanceActions["test"]>().mockResolvedValue({green: true, log: ""});
		const report = await advanceProject(
			planNeedsBaseline(unit("a"), unit("b")),
			actions({
				prepareBaseline: vi.fn<AdvanceActions["prepareBaseline"]>().mockResolvedValue("red"),
				test,
			}),
			opts,
		);
		expect(report.status).toBe("red");
		expect(report.detail).toBe("upstream broken");
		expect(report.children.map((c) => c.status)).toStrictEqual(["skipped", "skipped"]);
		expect(report.children.map((c) => c.detail)).toStrictEqual([
			"skipped: upstream broken",
			"skipped: upstream broken",
		]);
		expect(test).not.toHaveBeenCalled();
	});

	it("does not check the baseline when the plan says it is already green", async () => {
		const prepareBaseline = vi.fn<AdvanceActions["prepareBaseline"]>().mockResolvedValue("green");
		await advanceProject(plan(unit("a")), actions({prepareBaseline}), opts);
		expect(prepareBaseline).not.toHaveBeenCalled();
	});
});
