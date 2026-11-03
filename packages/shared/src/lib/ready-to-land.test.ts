import {describe, expect, it} from "vite-plus/test";
import {
	landingOrder,
	stableRowOrder,
	prChecksPending,
	prChecksFailed,
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

const seen = (readyItem: ReadyToLandItem, firstSeen: string): ReadyToLandItem => ({...readyItem, firstSeen});

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

describe("stableRowOrder", () => {
	it("orders rows by first seen, then project, then patch-id, whatever order the server sent them in", () => {
		const a = seen(item("b", "d1"), "2026-01-02 00:00:00");
		const b = seen(item("a", "c9"), "2026-01-01 00:00:00");
		const c = seen(item("a", "c1"), "2026-01-02 00:00:00");
		const d = item("a", "c0");
		const expected = [b, c, a, d];

		expect({
			forward: stableRowOrder([a, b, c, d]),
			reversed: stableRowOrder([d, c, b, a]),
		}).toStrictEqual({forward: expected, reversed: expected});
	});

	it("keeps a row's place when it moves between the ready, waiting and checks-failed lists", () => {
		const one = seen(item("a", "c1"), "2026-01-01 00:00:00");
		const two = seen(item("b", "d1"), "2026-01-02 00:00:00");
		const three = seen(item("a", "c3"), "2026-01-03 00:00:00");

		expect({
			allReady: stableRowOrder([one, two, three]),
			twoWaiting: stableRowOrder([one, three, two]),
			oneFailed: stableRowOrder([two, three, one]),
		}).toStrictEqual({allReady: [one, two, three], twoWaiting: [one, two, three], oneFailed: [one, two, three]});
	});

	it("still lands a stack prefix before the commit stacked on it", () => {
		const child = seen(item("a", "c2", "c1"), "2026-01-01 00:00:00");
		const parent = seen(item("a", "c1"), "2026-01-02 00:00:00");
		const other = seen(item("b", "d1"), "2026-01-01 12:00:00");

		expect(stableRowOrder([other, parent, child])).toStrictEqual([parent, child, other]);
	});

	it("puts a higher priority first, so a newer high-priority item sorts above an older normal one", () => {
		const olderMedium = seen(item("a", "c1"), "2026-01-01 00:00:00");
		const newerHigh = {...seen(item("b", "d1"), "2026-01-03 00:00:00"), priority: "high" as const};
		const olderLow = {...seen(item("a", "c0"), "2025-12-01 00:00:00"), priority: "low" as const};
		const newerMedium = {...seen(item("c", "e1"), "2026-01-02 00:00:00"), priority: "medium" as const};

		expect(stableRowOrder([olderLow, olderMedium, newerMedium, newerHigh])).toStrictEqual([
			newerHigh,
			olderMedium,
			newerMedium,
			olderLow,
		]);
	});

	it("keeps a stacked commit after its parent even when the commit has the higher priority", () => {
		const parent = {...seen(item("a", "c1"), "2026-01-01 00:00:00"), priority: "low" as const};
		const child = {...seen(item("a", "c2", "c1"), "2026-01-02 00:00:00"), priority: "high" as const};
		const other = seen(item("b", "d1"), "2026-01-01 00:00:00");

		expect(stableRowOrder([other, child, parent])).toStrictEqual([parent, child, other]);
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

	it("lands a row whose PR checks passed, a row with no PR yet, and every fast-forward row", () => {
		expect([
			readyRowView(pr, commit({checkStatus: "passed"})),
			readyRowView(pr, {checkStatus: "none"}),
			readyRowView(pr, undefined),
			readyRowView({...pr, landing: "fast-forward"}, commit()),
			readyRowView({...pr, landing: "fast-forward"}, commit({checkStatus: "failed"})),
			readyRowView(pr, commit({checkStatus: "none", mergeStateStatus: "CLEAN"})),
		]).toStrictEqual(["land", "land", "land", "land", "land", "land"]);
	});

	it("never lands a PR whose checks failed, even where the repo allows auto-merge or it is on", () => {
		expect([
			readyRowView(pr, commit({checkStatus: "failed"})),
			readyRowView(pr, commit({checkStatus: "failed", mergeStateStatus: "UNSTABLE", autoMergeAllowed: true})),
			readyRowView(pr, commit({checkStatus: "failed", autoMerge: true})),
		]).toStrictEqual(["checks-failed", "checks-failed", "checks-failed"]);
	});

	it("shows a PR whose checks are pending or not yet reported as waiting when the repo has no auto-merge", () => {
		expect([
			readyRowView(pr, commit({checkStatus: "pending"})),
			readyRowView(pr, commit({checkStatus: "running"})),
			readyRowView(pr, commit({checkStatus: "none"})),
			readyRowView(pr, commit({checkStatus: "unknown", mergeStateStatus: "BLOCKED"})),
		]).toStrictEqual(["waiting", "waiting", "waiting", "waiting"]);
	});

	it("shows a pending PR as waiting once auto-merge is on, and still offers Merge PR where the repo allows auto-merge", () => {
		expect([
			readyRowView(pr, commit({autoMerge: true})),
			readyRowView(pr, commit({autoMergeAllowed: true})),
			readyRowView(pr, commit({autoMerge: true, checkStatus: "passed"})),
		]).toStrictEqual(["waiting", "land", "land"]);
	});
});

describe("prChecksFailed", () => {
	it("is true only for a PR whose checks failed", () => {
		expect([
			prChecksFailed({prNumber: 1, checkStatus: "failed"}),
			prChecksFailed({prNumber: 1, checkStatus: "passed"}),
			prChecksFailed({prNumber: 1, checkStatus: "running"}),
			prChecksFailed({checkStatus: "failed"}),
		]).toStrictEqual([true, false, false, false]);
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
