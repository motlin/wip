import {describe, expect, it} from "vite-plus/test";
import {landingOrder, ReadyToLandStateSchema, type ReadyToLandItem} from "./ready-to-land.js";

const item = (project: string, id: string, parentSha?: string): ReadyToLandItem => ({
	project,
	id,
	sha: id.padEnd(40, "0"),
	...(parentSha === undefined ? {} : {parentSha: parentSha.padEnd(40, "0")}),
});

describe("landingOrder", () => {
	it("pulls a stack prefix forward to just before the commit stacked on it, and keeps the rest in input order", () => {
		const items = [item("a", "c2", "c1"), item("b", "d1"), item("a", "c3", "c2"), item("a", "c1")];

		expect(landingOrder(items)).toStrictEqual([
			item("a", "c1"),
			item("a", "c2", "c1"),
			item("b", "d1"),
			item("a", "c3", "c2"),
		]);
	});

	it("keeps an item whose parent is not listed (on the upstream tip) where it is", () => {
		const items = [item("a", "c1", "ff"), item("b", "d1")];

		expect(landingOrder(items)).toStrictEqual(items);
	});

	it("only matches a parent within the same project", () => {
		const items = [item("b", "c2", "c1"), item("a", "c1")];

		expect(landingOrder(items)).toStrictEqual(items);
	});
});

describe("ReadyToLandStateSchema", () => {
	it("parses the buffer state the scheduler stream carries", () => {
		const state = {
			slots: 2,
			ready: [{project: "a", id: "p1", sha: "1".repeat(40), branch: "fix", landing: "pull-request"}],
			inFlight: [{project: "a", id: "p2", sha: "2".repeat(40)}],
			next: [],
			stoppedProjects: ["red"],
		};

		expect(ReadyToLandStateSchema.parse(state)).toStrictEqual(state);
	});
});
