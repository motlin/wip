import {describe, expect, it} from "vitest";

import {createWatchGate} from "./watch-gate";

function gateWithSnapshots(snapshots: Record<string, string[]>) {
	const cursors = new Map<string, number>();
	return createWatchGate(async (project) => {
		const series = snapshots[project] ?? [""];
		const cursor = cursors.get(project) ?? 0;
		const value = series[Math.min(cursor, series.length - 1)] ?? "";
		cursors.set(project, cursor + 1);
		return value;
	});
}

describe("createWatchGate", () => {
	it("allows the first fire for an unseen project", async () => {
		const gate = gateWithSnapshots({wip: ["refs-v1"]});
		await expect(gate.shouldRefresh("wip")).resolves.toBe(true);
	});

	it("drops fires whose ref state matches the last recorded refresh", async () => {
		// recordRefreshed sees refs-v1; the follow-up fire (our own write echo) still sees refs-v1.
		const gate = gateWithSnapshots({wip: ["refs-v1", "refs-v1"]});
		await gate.recordRefreshed("wip");
		await expect(gate.shouldRefresh("wip")).resolves.toBe(false);
	});

	it("passes fires when refs moved past the recorded snapshot", async () => {
		const gate = gateWithSnapshots({wip: ["refs-v1", "refs-v2"]});
		await gate.recordRefreshed("wip");
		await expect(gate.shouldRefresh("wip")).resolves.toBe(true);
	});

	it("absorbs a refresh's own ref writes once re-recorded", async () => {
		// fire (v1, passes) → refresh work moves refs to v2 → recordRefreshed (v2)
		// → echo fire sees v2 → dropped. The old timing race looped here forever.
		const gate = gateWithSnapshots({wip: ["refs-v1", "refs-v2", "refs-v2"]});
		await expect(gate.shouldRefresh("wip")).resolves.toBe(true);
		await gate.recordRefreshed("wip");
		await expect(gate.shouldRefresh("wip")).resolves.toBe(false);
	});

	it("fails open when the snapshot is unreadable", async () => {
		const gate = gateWithSnapshots({wip: [""]});
		await gate.recordRefreshed("wip");
		await expect(gate.shouldRefresh("wip")).resolves.toBe(true);
	});

	it("tracks projects independently", async () => {
		const gate = gateWithSnapshots({alpha: ["a1", "a1"], beta: ["b1", "b2"]});
		await gate.recordRefreshed("alpha");
		await gate.recordRefreshed("beta");
		await expect(gate.shouldRefresh("alpha")).resolves.toBe(false);
		await expect(gate.shouldRefresh("beta")).resolves.toBe(true);
	});
});
