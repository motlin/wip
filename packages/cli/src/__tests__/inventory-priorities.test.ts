import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {loadTestConfig} from "./test-config.js";

import {loadInventory, saveInventory, type ProjectRecord} from "@wip/shared";

import InventoryPriorities, {type InventoryPrioritiesResult} from "../commands/inventory/priorities.js";

const LADDER = {
	name: "📌 Tasks (asap) (personal)",
	id: "bucket",
	children: [
		{name: "1st", id: "t1", children: [{name: "alpha", id: "a"}]},
		{name: "2nd", id: "t2", children: []},
		{name: "3rd", id: "t3", children: [{name: "Polish the docs #beta", id: "b"}]},
	],
};

function priorities(): Record<string, string | undefined> {
	return Object.fromEntries(loadInventory().projects.map((project) => [project.name, project.priority]));
}

async function runPriorities(argv: string[]): Promise<InventoryPrioritiesResult> {
	const config = await loadTestConfig();
	return await new InventoryPriorities(argv, config).run();
}

describe("wip inventory priorities", () => {
	let tmp: string;
	let ladderFile: string;
	let originalXdg: string | undefined;

	function record(name: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
		return {name, dir: path.join(tmp, "projects", name), template: "typescript", kind: "own", ...extra};
	}

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wip-inv-priorities-"));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
		ladderFile = path.join(tmp, "ladder.json");
		fs.writeFileSync(ladderFile, JSON.stringify(LADDER));
		saveInventory([record("alpha"), record("beta", {priority: "low"}), record("gamma", {priority: "high"})]);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		fs.rmSync(tmp, {recursive: true, force: true});
	});

	it("proposes values for matched repos and writes nothing without confirmation", async () => {
		const result = await runPriorities(["--ladder", ladderFile, "--json"]);
		expect(result).toStrictEqual({
			proposals: [
				{
					name: "alpha",
					current: undefined,
					proposed: "high",
					tier: 1,
					ladder: "📌 Tasks (asap) (personal)",
					evidence: "alpha",
				},
				{
					name: "beta",
					current: "low",
					proposed: "medium",
					tier: 3,
					ladder: "📌 Tasks (asap) (personal)",
					evidence: "Polish the docs #beta",
				},
			],
			written: [],
		});
		expect(priorities()).toStrictEqual({alpha: undefined, beta: "low", gamma: "high"});
	});

	it("writes only the confirmed repos with --accept and leaves unmatched repos unchanged", async () => {
		const result = await runPriorities(["--ladder", ladderFile, "--accept", "beta", "--json"]);
		expect(result.written).toStrictEqual(["beta"]);
		expect(priorities()).toStrictEqual({alpha: undefined, beta: "medium", gamma: "high"});
	});

	it("writes every proposal with --yes", async () => {
		const result = await runPriorities(["--ladder", ladderFile, "--yes", "--json"]);
		expect(result.written).toStrictEqual(["alpha", "beta"]);
		expect(priorities()).toStrictEqual({alpha: "high", beta: "medium", gamma: "high"});
	});

	it("refuses to accept a repo that has no proposal", async () => {
		await expect(runPriorities(["--ladder", ladderFile, "--accept", "gamma", "--json"])).rejects.toThrow(
			/no proposal for gamma/,
		);
		expect(priorities()).toStrictEqual({alpha: undefined, beta: "low", gamma: "high"});
	});

	it("reads a bucket straight from the workflowy CLI", async () => {
		const fakeCli = path.join(tmp, "workflowy.sh");
		fs.writeFileSync(
			fakeCli,
			`#!/bin/sh\n[ "$1 $2 $3 $4" = "node get --id bucket-uuid" ] || exit 3\ncat '${ladderFile}'\n`,
			{mode: 0o755},
		);
		const result = await runPriorities(["--bucket", "bucket-uuid", "--workflowy-cli", fakeCli, "--json"]);
		expect(result.proposals.map((proposal) => [proposal.name, proposal.proposed])).toStrictEqual([
			["alpha", "high"],
			["beta", "medium"],
		]);
		expect(result.written).toStrictEqual([]);
	});
});
