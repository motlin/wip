import {describe, it, expect} from "vite-plus/test";

import {itemBackTarget} from "./item-back-link";

describe("itemBackTarget", () => {
	it("returns /snoozed when the item was opened from the snoozed page", () => {
		expect(itemBackTarget("/snoozed")).toBe("/snoozed");
	});

	it("returns /queue when no origin is given", () => {
		expect(itemBackTarget(undefined)).toBe("/queue");
	});

	it("returns /queue for any unrecognised origin", () => {
		expect(itemBackTarget("/kanban")).toBe("/queue");
		expect(itemBackTarget("https://example.com/snoozed")).toBe("/queue");
	});
});
