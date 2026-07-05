import {describe, expect, it} from "vitest";

import {formatRelativeAge, oldestTimestamp, parseDbTimestamp} from "./staleness";

const NOW = Date.parse("2026-07-04T12:00:00Z");

describe("parseDbTimestamp", () => {
	it("parses DB timestamps as UTC", () => {
		expect(parseDbTimestamp("2026-07-04 11:59:00.000")).toBe(Date.parse("2026-07-04T11:59:00.000Z"));
	});
});

describe("formatRelativeAge", () => {
	it("formats sub-minute ages as just now", () => {
		expect(formatRelativeAge("2026-07-04 11:59:41.000", NOW)).toBe("just now");
	});

	it("formats minutes", () => {
		expect(formatRelativeAge("2026-07-04 11:12:00.000", NOW)).toBe("48m ago");
	});

	it("formats hours", () => {
		expect(formatRelativeAge("2026-07-04 09:00:00.000", NOW)).toBe("3h ago");
	});

	it("formats days", () => {
		expect(formatRelativeAge("2026-07-01 09:00:00.000", NOW)).toBe("3d ago");
	});
});

describe("oldestTimestamp", () => {
	it("returns the oldest of the timestamps", () => {
		expect(oldestTimestamp(["2026-07-04 11:00:00.000", "2026-07-03 11:00:00.000", "2026-07-04 11:30:00.000"])).toBe(
			"2026-07-03 11:00:00.000",
		);
	});

	it("returns null for an empty list", () => {
		expect(oldestTimestamp([])).toBeNull();
	});
});
