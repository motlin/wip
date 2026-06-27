import {describe, it, expect} from "vite-plus/test";

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
		rebase: async () => okRebase,
		test: async () => ({green: true, log: ""}),
		resolveConflicts: async () => ({ok: true, log: ""}),
		fix: async () => ({changed: true, log: ""}),
		absorb: async () => ({ok: true, log: ""}),
		cleanup: async () => {},
		prepareBaseline: async () => "green",
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
		let tested = 0;
		const report = await advanceProject(
			plan(unit("a")),
			actions({
				test: async () => {
					tested += 1;
					return tested === 1 ? {green: false, log: "FAIL Foo.bar"} : {green: true, log: ""};
				},
			}),
			opts,
		);
		expect(report.children[0]?.status).toBe("green");
		expect(tested).toBe(2); // failed once, fixed, passed
	});

	it("marks a branch stuck when the same failure recurs after a fix", async () => {
		const report = await advanceProject(
			plan(unit("a")),
			actions({
				test: async () => ({green: false, log: "FAIL Foo.bar\nAssertionError: 1 != 2"}),
				fix: async () => ({changed: true, log: ""}),
			}),
			opts,
		);
		expect(report.children[0]?.status).toBe("stuck");
		expect(report.status).toBe("red");
	});

	it("does not fix in dry-run, reporting the failing branch red", async () => {
		const report = await advanceProject(
			plan(unit("a")),
			actions({test: async () => ({green: false, log: "FAIL x"})}),
			{...opts, autonomy: "dry-run"},
		);
		expect(report.children[0]?.status).toBe("red");
	});

	it("resolves conflicts then continues to test", async () => {
		let resolved = false;
		const report = await advanceProject(
			plan(unit("a")),
			actions({
				rebase: async () => ({ok: false, conflict: true, log: "CONFLICT in App.tsx"}),
				resolveConflicts: async () => {
					resolved = true;
					return {ok: true, log: ""};
				},
			}),
			opts,
		);
		expect(resolved).toBe(true);
		expect(report.children[0]?.status).toBe("green");
	});

	it("cascade-skips a dependent when its dependency fails", async () => {
		const report = await advanceProject(
			plan(unit("a"), unit("b", ["a"])),
			actions({
				test: async (u) => (u.id === "a" ? {green: false, log: "FAIL a"} : {green: true, log: ""}),
				fix: async () => ({changed: false, log: ""}), // a gets stuck (no change)
			}),
			opts,
		);
		const byBranch = Object.fromEntries(report.children.map((c) => [c.label, c.status]));
		expect(byBranch["a"]).toBe("stuck");
		expect(byBranch["b"]).toBe("skipped");
	});

	it("cleans up every unit when the run finishes green", async () => {
		const cleaned: string[] = [];
		await advanceProject(
			plan(unit("a"), unit("b")),
			actions({
				cleanup: async (u) => {
					cleaned.push(u.id);
				},
			}),
			opts,
		);
		expect(cleaned.sort()).toStrictEqual(["a", "b"]);
	});

	it("cleans up a unit even when it gets stuck", async () => {
		const cleaned: string[] = [];
		await advanceProject(
			plan(unit("a")),
			actions({
				test: async () => ({green: false, log: "FAIL Foo.bar"}),
				fix: async () => ({changed: false, log: ""}),
				cleanup: async (u) => {
					cleaned.push(u.id);
				},
			}),
			opts,
		);
		expect(cleaned).toStrictEqual(["a"]);
	});

	it("marks the project upstream_fixed when the baseline was repaired", async () => {
		const report = await advanceProject(
			planNeedsBaseline(unit("a"), unit("b")),
			actions({prepareBaseline: async () => "fixed"}),
			opts,
		);
		expect(report.status).toBe("upstream_fixed");
		expect(report.children.map((c) => c.status)).toStrictEqual(["green", "green"]);
	});

	it("skips every unit and reports red when the baseline is broken and unfixable", async () => {
		let testedUnits = 0;
		const report = await advanceProject(
			planNeedsBaseline(unit("a"), unit("b")),
			actions({
				prepareBaseline: async () => "red",
				test: async () => {
					testedUnits += 1;
					return {green: true, log: ""};
				},
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
		expect(testedUnits).toBe(0);
	});

	it("does not check the baseline when the plan says it is already green", async () => {
		let prepared = 0;
		await advanceProject(
			plan(unit("a")),
			actions({
				prepareBaseline: async () => {
					prepared += 1;
					return "green";
				},
			}),
			opts,
		);
		expect(prepared).toBe(0);
	});
});
