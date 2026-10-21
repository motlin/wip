import {describe, it, expect, expectTypeOf} from "vite-plus/test";

import {createSystemProbe} from "./system-probe.js";
import type {WorkResourceProbe} from "./work-queue.js";
import type {AdvanceProjectOptions} from "./advance.js";
import type {AdvanceQueueOptions} from "./advance-queue.js";

describe("createSystemProbe", () => {
	it("is the single WorkResourceProbe contract used by the queue and advance", () => {
		expectTypeOf(createSystemProbe()).toEqualTypeOf<WorkResourceProbe>();
		expectTypeOf<NonNullable<AdvanceProjectOptions["probe"]>>().toEqualTypeOf<WorkResourceProbe>();
		expectTypeOf<AdvanceQueueOptions["probe"]>().toEqualTypeOf<WorkResourceProbe>();
	});

	it("reports a non-negative load per core and a free-memory ratio within 0..1", () => {
		const probe = createSystemProbe();

		expect(probe.loadPerCore()).toBeGreaterThanOrEqual(0);
		expect(probe.freeMemRatio()).toBeGreaterThanOrEqual(0);
		expect(probe.freeMemRatio()).toBeLessThanOrEqual(1);
	});
});
