import {describe, it, expect} from "vite-plus/test";

import {snoozeLabel} from "./snooze-label";

const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("snoozeLabel", () => {
	it.each([
		{name: "untimed row reads as On hold", until: null, expected: "On hold"},
		{name: "minutes left", until: "2026-10-26T12:30:00.000Z", expected: "30m remaining"},
		{name: "hours left", until: "2026-10-26T17:00:00.000Z", expected: "5h remaining"},
		{name: "days left", until: "2026-10-29T12:00:00.000Z", expected: "3d remaining"},
		{name: "past until reads as expired", until: "2026-10-26T11:00:00.000Z", expected: "Expired"},
	])("$name", ({until, expected}) => {
		expect(snoozeLabel(until, NOW)).toBe(expected);
	});
});
