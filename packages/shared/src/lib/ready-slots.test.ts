import {describe, expect, it} from "vite-plus/test";

import {allocateReadySlots, type ReadySlotItem, type ReadySlotRepo} from "./ready-slots.js";

function item(repo: string, id: string, overrides: Partial<ReadySlotItem> = {}): ReadySlotItem {
	return {repo, id, state: "unready", onHold: false, ...overrides};
}

describe("allocateReadySlots", () => {
	const repos: ReadySlotRepo[] = [
		{name: "hi", priority: "high"},
		{name: "mid", priority: "medium"},
		{name: "unset"},
		{name: "lo", priority: "low"},
	];

	it("gives the highest tier with unready work 2 slots, the next 1 and lower tiers 0", () => {
		const items = [item("hi", "h1"), item("mid", "m1"), item("unset", "u1"), item("lo", "l1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 2, tier: "high", pullable: ["h1"]},
			mid: {slots: 1, tier: "medium", pullable: ["m1"]},
			unset: {slots: 1, tier: "medium", pullable: ["u1"]},
			lo: {slots: 0, tier: "low", pullable: ["l1"]},
		});
	});

	it("cascades when every high-priority item is ready or landed", () => {
		const items = [
			item("hi", "h1", {state: "ready"}),
			item("hi", "h2", {state: "landed"}),
			item("mid", "m1"),
			item("lo", "l1"),
		];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 0, tier: null, pullable: []},
			mid: {slots: 2, tier: "medium", pullable: ["m1"]},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 1, tier: "low", pullable: ["l1"]},
		});
	});

	it("skips an empty tier so the next non-empty tier moves up", () => {
		const items = [item("hi", "h1"), item("lo", "l1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 2, tier: "high", pullable: ["h1"]},
			mid: {slots: 0, tier: null, pullable: []},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 1, tier: "low", pullable: ["l1"]},
		});
	});

	it("places an overridden item in its own tier, and its repo pulls only from its highest tier", () => {
		const items = [item("lo", "l1", {override: "high"}), item("lo", "l2"), item("mid", "m1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 0, tier: null, pullable: []},
			mid: {slots: 1, tier: "medium", pullable: ["m1"]},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 2, tier: "high", pullable: ["l1"]},
		});
	});

	it("lets an override demote an item out of its repo's tier", () => {
		const items = [item("hi", "h1", {override: "low"}), item("mid", "m1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 1, tier: "low", pullable: ["h1"]},
			mid: {slots: 2, tier: "medium", pullable: ["m1"]},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 0, tier: null, pullable: []},
		});
	});

	it("gives an on-hold item no slot and lets its tier cascade", () => {
		const items = [item("hi", "h1", {onHold: true}), item("mid", "m1"), item("lo", "l1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 0, tier: null, pullable: []},
			mid: {slots: 2, tier: "medium", pullable: ["m1"]},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 1, tier: "low", pullable: ["l1"]},
		});
	});

	it("excludes an on-hold item from its repo's pullable list", () => {
		const items = [item("hi", "h1", {onHold: true}), item("hi", "h2")];
		expect(allocateReadySlots(repos, items).get("hi")).toStrictEqual({slots: 2, tier: "high", pullable: ["h2"]});
	});

	it("ignores items for repos outside the registry list", () => {
		const items = [item("ghost", "g1", {override: "high"}), item("mid", "m1")];
		expect(Object.fromEntries(allocateReadySlots(repos, items))).toStrictEqual({
			hi: {slots: 0, tier: null, pullable: []},
			mid: {slots: 2, tier: "medium", pullable: ["m1"]},
			unset: {slots: 0, tier: null, pullable: []},
			lo: {slots: 0, tier: null, pullable: []},
		});
	});
});
