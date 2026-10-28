// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {FlowMetricsStrip} from "./flow-metrics-strip";

describe("FlowMetricsStrip", () => {
	afterEach(() => {
		cleanup();
	});

	it("shows WIP, landings per day over 7 and 28 days, median lead time and the Little's-law estimate", () => {
		render(
			<FlowMetricsStrip
				metrics={{
					wip: 6,
					landingsPerDay7d: 3 / 7,
					landingsPerDay28d: 8 / 28,
					medianLeadTimeDays: 2.25,
					littlesLawDays: 6 / (8 / 28),
					stateCounts: {test_failed: 6},
				}}
			/>,
		);
		expect(screen.getByTestId("flow-metrics-strip").textContent).toBe(
			"WIP 6 · landings/day 0.4 (7d) · 0.3 (28d) · median lead time 2.3d · Little's law 21.0d",
		);
	});

	it("shows dashes for lead time and Little's law with no landings", () => {
		render(
			<FlowMetricsStrip
				metrics={{
					wip: 2,
					landingsPerDay7d: 0,
					landingsPerDay28d: 0,
					medianLeadTimeDays: null,
					littlesLawDays: null,
					stateCounts: {ready_to_test: 2},
				}}
			/>,
		);
		expect(screen.getByTestId("flow-metrics-strip").textContent).toBe(
			"WIP 2 · landings/day 0.0 (7d) · 0.0 (28d) · median lead time – · Little's law –",
		);
	});
});
