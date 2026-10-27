import {describe, expect, it} from "vite-plus/test";

import type {LadderResult, LadderRungName} from "./ladder.js";
import {runLadder, type LadderRunner} from "./ladder-rungs.js";

const project = {
	name: "p",
	path: "/tmp/does-not-exist-p",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
	dirty: false,
	detached: false,
	rebaseInProgress: false,
	offline: false,
	backgroundRebase: true,
};

function passing(calls: string[], rung: LadderRungName): LadderRunner {
	return async () => {
		calls.push(rung);
		return Promise.resolve({project: "p", rungs: [{rung, status: "passed", detail: rung}]});
	};
}

function fakeRunners(calls: string[], overrides: Partial<Record<LadderRungName, LadderRunner>> = {}) {
	const names: LadderRungName[] = ["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"];
	return Object.fromEntries(names.map((n) => [n, overrides[n] ?? passing(calls, n)])) as Record<
		LadderRungName,
		LadderRunner
	>;
}

describe("runLadder", () => {
	it("runs the planned rungs in order", async () => {
		const calls: string[] = [];
		const result = await runLadder(project, {runners: fakeRunners(calls)});
		expect(calls).toEqual(["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"]);
		expect(result.rungs.map((r) => r.rung)).toEqual(calls);
		expect(result.stop).toBeUndefined();
	});

	it("only runs rungs that planLadder allows", async () => {
		const calls: string[] = [];
		await runLadder({...project, dirty: true, offline: true}, {runners: fakeRunners(calls)});
		expect(calls).toEqual(["replay", "worktree-prune"]);
	});

	it("stops at the first stopped rung and returns its stop", async () => {
		const calls: string[] = [];
		const stopped: LadderRunner = async () => {
			calls.push("replay");
			return Promise.resolve({
				project: "p",
				rungs: [{rung: "replay", status: "stopped", detail: "boom"}],
				stop: {stop: "conflict", branches: ["b"]},
			} satisfies LadderResult);
		};
		const result = await runLadder(project, {runners: fakeRunners(calls, {replay: stopped})});
		expect(calls).toEqual(["fetch", "replay"]);
		expect(result).toEqual({
			project: "p",
			rungs: [
				{rung: "fetch", status: "passed", detail: "fetch"},
				{rung: "replay", status: "stopped", detail: "boom"},
			],
			stop: {stop: "conflict", branches: ["b"]},
		});
	});

	it("dry run returns the plan and runs nothing", async () => {
		const calls: string[] = [];
		const result = await runLadder(project, {dryRun: true, runners: fakeRunners(calls)});
		expect(calls).toEqual([]);
		expect(result).toEqual({
			project: "p",
			rungs: ["fetch", "replay", "rebase-leftovers", "worktree-prune", "delete-merged-local"].map((rung) => ({
				rung,
				status: "skipped",
				detail: "dry run",
			})),
		});
	});

	it("checks the abort signal between rungs", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		const first: LadderRunner = async () => {
			calls.push("fetch");
			controller.abort();
			return Promise.resolve({project: "p", rungs: [{rung: "fetch", status: "passed", detail: "fetch"}]});
		};
		const result = await runLadder(project, {
			signal: controller.signal,
			runners: fakeRunners(calls, {fetch: first}),
		});
		expect(calls).toEqual(["fetch"]);
		expect(result).toEqual({
			project: "p",
			rungs: [
				{rung: "fetch", status: "passed", detail: "fetch"},
				{rung: "replay", status: "stopped", detail: "aborted"},
			],
			stop: {stop: "error", branches: []},
		});
	});

	it("passes the signal to runners via the project", async () => {
		const controller = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		const spy: LadderRunner = async (p) => {
			seen.push(p.signal);
			return Promise.resolve({project: "p", rungs: [{rung: "fetch", status: "passed", detail: ""}]});
		};
		await runLadder(project, {signal: controller.signal, runners: fakeRunners([], {fetch: spy})});
		expect(seen).toEqual([controller.signal]);
	});
});
