import {describe, it, expect, beforeEach} from "vite-plus/test";

import {runPendingAction} from "./pending-action.js";
import {clearToasts, getToasts} from "./toast-store.js";

describe("runPendingAction", () => {
	beforeEach(() => {
		clearToasts();
	});

	it("sets pending true while running and false afterwards on success, with no toast", async () => {
		const states: boolean[] = [];
		await runPendingAction(
			"Merge PR",
			(pending) => states.push(pending),
			async () => Promise.resolve(),
		);

		expect(states).toEqual([true, false]);
		expect(getToasts()).toEqual([]);
	});

	it("resets pending to false and surfaces an error toast when the action rejects, without throwing", async () => {
		const states: boolean[] = [];
		const ok = await runPendingAction(
			"Refresh all",
			(pending) => states.push(pending),
			async () => Promise.reject(new Error("network down")),
		);

		expect(ok).toBe(false);
		expect(states).toEqual([true, false]);
		expect(getToasts().map((t) => ({level: t.level, message: t.message, detail: t.detail}))).toEqual([
			{level: "error", message: "Refresh all", detail: "network down"},
		]);
	});

	it("runs without a pending setter for fire-and-forget actions", async () => {
		const ok = await runPendingAction("Push", undefined, async () => Promise.reject(new Error("boom")));

		expect(ok).toBe(false);
		expect(getToasts().map((t) => ({level: t.level, message: t.message, detail: t.detail}))).toEqual([
			{level: "error", message: "Push", detail: "boom"},
		]);
	});
});
