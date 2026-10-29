import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {
	diffInventories,
	inventoryExists,
	landingMode,
	loadInventory,
	saveInventory,
	selectTrackedProjects,
	trustsPatchIdGreen,
	type ProjectRecord,
} from "./inventory.js";

describe("inventory", () => {
	let tmp: string;
	let originalXdg: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wip-inventory-"));
		originalXdg = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = tmp;
	});

	afterEach(() => {
		if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = originalXdg;
		fs.rmSync(tmp, {recursive: true, force: true});
	});

	const beta: ProjectRecord = {name: "beta", dir: "/p/beta", template: "typescript", kind: "own"};
	const alpha: ProjectRecord = {
		name: "alpha",
		dir: "/p/alpha",
		template: "java",
		kind: "fork",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		notes: "n",
	};

	it("loads a missing file as an empty inventory", () => {
		expect(loadInventory()).toEqual({projects: [], errors: []});
	});

	it("round trips and orders by name", () => {
		saveInventory([beta, alpha]);
		expect(fs.existsSync(path.join(tmp, "wip", "projects.json5"))).toBe(true);
		expect(loadInventory()).toEqual({projects: [alpha, beta], errors: []});
	});

	it("reports invalid entries without dropping valid ones", () => {
		fs.mkdirSync(path.join(tmp, "wip"), {recursive: true});
		fs.writeFileSync(
			path.join(tmp, "wip", "projects.json5"),
			JSON.stringify([beta, {name: "bad", dir: "relative", template: "cobol", kind: "own"}]),
		);
		const result = loadInventory();
		expect(result.projects).toEqual([beta]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({index: 1});
	});

	it("reports whether a registry file exists", () => {
		expect(inventoryExists()).toBe(false);
		saveInventory([]);
		expect(inventoryExists()).toBe(true);
	});
});

describe("diffInventories", () => {
	const a: ProjectRecord = {name: "a", dir: "/p/a", template: "java", kind: "own"};
	const b: ProjectRecord = {name: "b", dir: "/p/b", template: "rust", kind: "fork"};
	const c: ProjectRecord = {name: "c", dir: "/p/c", template: "rust", kind: "own"};

	it("splits added, removed, changed by dir", () => {
		const bChanged: ProjectRecord = {...b, kind: "skip"};
		expect(diffInventories([a, b], [bChanged, c])).toEqual({
			added: [c],
			removed: [a],
			changed: [{before: b, after: bChanged}],
		});
	});

	it("is empty for identical inventories", () => {
		expect(diffInventories([a], [{...a}])).toEqual({added: [], removed: [], changed: []});
	});
});

describe("selectTrackedProjects", () => {
	const records: ProjectRecord[] = [
		{name: "own", dir: "/p/own", template: "typescript", kind: "own"},
		{name: "fork", dir: "/p/fork/", template: "typescript", kind: "fork"},
		{name: "nested", dir: "/p/nested", template: "java", kind: "nested"},
		{name: "skipped", dir: "/p/skipped", template: "project", kind: "skip"},
		{name: "missing", dir: "/p/missing", template: "rust", kind: "own"},
	];

	it("keeps only discovered projects whose directory the registry tracks as own, fork, or nested", () => {
		const discovered = [
			{name: "fork", dir: "/p/fork"},
			{name: "nested", dir: "/p/nested"},
			{name: "own", dir: "/p/own"},
			{name: "skipped", dir: "/p/skipped"},
			{name: "stray", dir: "/p/stray"},
		];
		expect(selectTrackedProjects(discovered, records)).toEqual([
			{name: "fork", dir: "/p/fork"},
			{name: "nested", dir: "/p/nested"},
			{name: "own", dir: "/p/own"},
		]);
	});
});

function record(overrides: Partial<ProjectRecord>): ProjectRecord {
	return {name: "r", dir: "/p/r", template: "typescript", kind: "own", ...overrides};
}

describe("landingMode and trustsPatchIdGreen", () => {
	it("lands by pull request until the registry configures otherwise, whatever the kind", () => {
		expect({
			fork: landingMode(record({kind: "fork"})),
			own: landingMode(record({kind: "own"})),
			ownPr: landingMode(record({kind: "own", landing: "pull-request"})),
			forkFf: landingMode(record({kind: "fork", landing: "fast-forward"})),
		}).toStrictEqual({fork: "pull-request", own: "pull-request", ownPr: "pull-request", forkFf: "fast-forward"});
	});

	it("trusts a pre-replay green only with the setting on in a pull-request repo", () => {
		expect({
			onPr: trustsPatchIdGreen(record({kind: "fork", trustPatchIdGreen: true})),
			offPr: trustsPatchIdGreen(record({kind: "fork"})),
			onUnsetOwn: trustsPatchIdGreen(record({kind: "own", trustPatchIdGreen: true})),
			onFastForward: trustsPatchIdGreen(record({kind: "fork", landing: "fast-forward", trustPatchIdGreen: true})),
		}).toStrictEqual({onPr: true, offPr: false, onUnsetOwn: true, onFastForward: false});
	});
});
