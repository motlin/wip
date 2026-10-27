import {describe, expect, it} from "vite-plus/test";

import {renderTree} from "./advance-report.js";
import {ladderResultsToTree, runLadderAcrossProjects, type LadderAllProject} from "./ladder-all.js";
import type {LadderResult} from "./ladder.js";
import {fakeCountedLock} from "../test/fake-counted-lock.js";
import type {WorkResourceProbe} from "./work-queue.js";

const probe: WorkResourceProbe = {loadPerCore: () => 0, freeMemRatio: () => 1};

function project(name: string): LadderAllProject {
	return {
		name,
		dir: `/tmp/does-not-exist-${name}`,
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		dirty: false,
		detachedHead: false,
		rebaseInProgress: false,
	};
}

const passed = (name: string): LadderResult => ({
	project: name,
	rungs: [{rung: "fetch", status: "passed", detail: "ok"}],
});

describe("runLadderAcrossProjects", () => {
	it("runs runLadder for every project and returns results in input order", async () => {
		const seen: string[] = [];
		const results = await runLadderAcrossProjects([project("a"), project("b"), project("c")], {
			probe,
			globalConcurrency: 2,
			runLadder: async (p) => {
				seen.push(p.name);
				return Promise.resolve(passed(p.name));
			},
		});
		expect(results).toEqual([passed("a"), passed("b"), passed("c")]);
		expect(new Set(seen)).toEqual(new Set(["a", "b", "c"]));
	});

	it("passes project fields and dryRun to runLadder", async () => {
		const calls: unknown[] = [];
		await runLadderAcrossProjects([{...project("a"), dirty: true}], {
			probe,
			dryRun: true,
			runLadder: async (p, o) => {
				calls.push([p, o?.dryRun]);
				return Promise.resolve(passed("a"));
			},
		});
		expect(calls).toEqual([
			[
				{
					name: "a",
					path: "/tmp/does-not-exist-a",
					upstreamRemote: "upstream",
					upstreamBranch: "main",
					dirty: true,
					detached: false,
					rebaseInProgress: false,
					offline: false,
				},
				true,
			],
		]);
	});

	it("bounds parallelism by globalConcurrency", async () => {
		let active = 0;
		let max = 0;
		await runLadderAcrossProjects([project("a"), project("b"), project("c"), project("d")], {
			probe,
			globalConcurrency: 2,
			runLadder: async (p) => {
				active++;
				max = Math.max(max, active);
				await new Promise<void>((r) => {
					setTimeout(r, 10);
				});
				active--;
				return passed(p.name);
			},
		});
		expect(max).toBe(2);
	});

	it("turns a thrown runLadder into an error stop without failing other projects", async () => {
		const results = await runLadderAcrossProjects([project("a"), project("b")], {
			probe,
			runLadder: async (p) => {
				if (p.name === "a") throw new Error("boom");
				return Promise.resolve(passed(p.name));
			},
		});
		expect(results).toEqual([{project: "a", rungs: [], stop: {stop: "error", branches: []}}, passed("b")]);
	});
});

describe("ladderResultsToTree", () => {
	it("summarizes stop reasons per project", () => {
		const tree = ladderResultsToTree(
			[
				passed("a"),
				{
					project: "b",
					rungs: [{rung: "rebase-leftovers", status: "stopped", detail: "conflict in x"}],
					stop: {stop: "conflict", branches: ["x"]},
				},
			],
			false,
		);
		expect(tree).toEqual({
			label: "ladder",
			status: "red",
			children: [
				{label: "a", status: "green", detail: "1 rung(s) passed", children: []},
				{label: "b", status: "stuck", detail: "stopped: conflict (x)", children: []},
			],
		});
		expect(renderTree(tree)).toContain("stopped: conflict (x)");
	});

	it("labels dry runs", () => {
		const tree = ladderResultsToTree(
			[{project: "a", rungs: [{rung: "fetch", status: "skipped", detail: "dry run"}]}],
			true,
		);
		expect(tree).toEqual({
			label: "ladder (dry run)",
			status: "green",
			children: [{label: "a", status: "skipped", detail: "would run: fetch", children: []}],
		});
	});
});

describe("runLadderAcrossProjects machine build budget", () => {
	it("holds the shared build lock around every project's ladder", async () => {
		let active = 0;
		let peak = 0;
		const {lock: buildLock, requested} = fakeCountedLock(1);
		const results = await runLadderAcrossProjects([project("a"), project("b")], {
			probe,
			globalConcurrency: 2,
			buildLock,
			runLadder: async (p) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => {
					setTimeout(resolve, 10);
				});
				active -= 1;
				return passed(p.name);
			},
		});

		expect({results, peak, requested}).toEqual({
			results: [passed("a"), passed("b")],
			peak: 1,
			requested: ["machine:build", "machine:build"],
		});
	});
});
