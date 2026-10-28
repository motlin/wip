import {describe, expect, it} from "vite-plus/test";

import {formatRelativeAge, freshnessSummary, parseDbTimestamp, wipAgeText} from "./staleness";

const NOW = Date.parse("2026-07-04T12:00:00Z");

describe("parseDbTimestamp", () => {
	it("parses DB timestamps as UTC", () => {
		expect(parseDbTimestamp("2026-07-04 11:59:00.000")).toBe(Date.parse("2026-07-04T11:59:00.000Z"));
	});

	it("parses ISO timestamps that already carry a zone, as the ledger writes them", () => {
		expect(parseDbTimestamp("2026-07-04T11:59:00.000Z")).toBe(Date.parse("2026-07-04T11:59:00.000Z"));
	});
});

describe("formatRelativeAge", () => {
	it("formats sub-minute ages as just now", () => {
		expect(formatRelativeAge("2026-07-04 11:59:41.000", NOW)).toBe("just now");
	});

	it("formats minutes", () => {
		expect(formatRelativeAge("2026-07-04 11:12:00.000", NOW)).toBe("48 min ago");
	});

	it("formats hours", () => {
		expect(formatRelativeAge("2026-07-04 09:00:00.000", NOW)).toBe("3h ago");
	});

	it("formats days", () => {
		expect(formatRelativeAge("2026-07-01 09:00:00.000", NOW)).toBe("3d ago");
	});
});

describe("freshnessSummary", () => {
	it("takes the median refresh, so one long-stale project cannot age the whole page, and lists the stale projects", () => {
		expect(
			freshnessSummary(
				{
					zeta: "2026-07-04 11:58:00.000",
					alpha: "2026-07-04 11:50:00.000",
					kempt: "2026-01-09 13:58:00.000",
					beta: "2026-07-04 11:30:00.000",
					gamma: "2026-07-04 11:55:00.000",
				},
				NOW,
				15,
			),
		).toStrictEqual({refreshedAt: "2026-07-04 11:50:00.000", staleProjects: ["beta", "kempt"]});
	});

	it("takes the older of the two middle refreshes for an even count", () => {
		expect(freshnessSummary({a: "2026-07-04 11:58:00.000", b: "2026-07-04 11:50:00.000"}, NOW, 15)).toStrictEqual({
			refreshedAt: "2026-07-04 11:50:00.000",
			staleProjects: [],
		});
	});

	it("has no refresh time before any project has refreshed", () => {
		expect(freshnessSummary({}, NOW, 15)).toStrictEqual({refreshedAt: null, staleProjects: []});
	});
});

describe("wipAgeText", () => {
	it("counts whole days in wip from first seen, for ledger and DB timestamps alike", () => {
		expect([
			wipAgeText("2026-07-04T11:00:00.000Z", NOW),
			wipAgeText("2026-07-01T09:00:00.000Z", NOW),
			wipAgeText("2026-06-04 12:00:00.000", NOW),
			wipAgeText("2026-07-05T00:00:00.000Z", NOW),
		]).toStrictEqual(["in wip 0d", "in wip 3d", "in wip 30d", "in wip 0d"]);
	});
});
