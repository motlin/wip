import {describe, expect, it} from "vite-plus/test";
import {
	landingOrder,
	prChecksPending,
	readyRowView,
	ReadyToLandStateSchema,
	type ReadyToLandItem,
} from "./ready-to-land.js";

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

type RowCommit = NonNullable<Parameters<typeof readyRowView>[1]>;

function commit(fields: Partial<RowCommit> = {}): RowCommit {
	return {prNumber: 9, checkStatus: "running", ...fields};
}

describe("readyRowView", () => {
	const pr = {...item("p", "c1"), landing: "pull-request" as const};

	it("lands a row whose PR checks passed or failed, a row with no PR yet, and every fast-forward row", () => {
		expect([
			readyRowView(pr, commit({checkStatus: "passed"})),
			readyRowView(pr, commit({checkStatus: "failed"})),
			readyRowView(pr, {checkStatus: "none"}),
			readyRowView(pr, undefined),
			readyRowView({...pr, landing: "fast-forward"}, commit()),
			readyRowView(pr, commit({checkStatus: "none", mergeStateStatus: "CLEAN"})),
		]).toStrictEqual(["land", "land", "land", "land", "land", "land"]);
	});

	it("hides a PR whose checks are pending or not yet reported when the repo has no auto-merge", () => {
		expect([
			readyRowView(pr, commit({checkStatus: "pending"})),
			readyRowView(pr, commit({checkStatus: "running"})),
			readyRowView(pr, commit({checkStatus: "none"})),
			readyRowView(pr, commit({checkStatus: "unknown", mergeStateStatus: "BLOCKED"})),
		]).toStrictEqual(["hidden", "hidden", "hidden", "hidden"]);
	});

	it("shows a pending PR as merging once auto-merge is on, and still offers Merge PR where the repo allows auto-merge", () => {
		expect([
			readyRowView(pr, commit({autoMerge: true})),
			readyRowView(pr, commit({autoMergeAllowed: true})),
			readyRowView(pr, commit({autoMerge: true, checkStatus: "passed"})),
		]).toStrictEqual(["merging", "land", "land"]);
	});
});

describe("prChecksPending", () => {
	it("is true only for a PR whose checks are running or not yet reported", () => {
		expect([
			prChecksPending({prNumber: 1, checkStatus: "pending"}),
			prChecksPending({prNumber: 1, checkStatus: "none"}),
			prChecksPending({prNumber: 1, checkStatus: "none", mergeStateStatus: "HAS_HOOKS"}),
			prChecksPending({prNumber: 1, checkStatus: "passed"}),
			prChecksPending({checkStatus: "running"}),
		]).toStrictEqual([true, true, false, false, false]);
	});
});
