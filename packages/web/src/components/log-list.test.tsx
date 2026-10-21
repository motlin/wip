// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {cleanup, render, waitFor} from "@testing-library/react";
import type {LogEntry} from "@wip/shared";
import {LogList, type KeyedEntry} from "./log-list.js";

function makeEntries(count: number): KeyedEntry[] {
	return Array.from({length: count}, (_, id) => {
		const entry: LogEntry = {time: 1_700_000_000_000 + id, level: 30, category: "general", msg: `message ${id}`};
		return {id, entry};
	});
}

describe("LogList", () => {
	beforeEach(() => {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {configurable: true, value: 24});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {configurable: true, value: 600});
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {configurable: true, value: 800});
		HTMLElement.prototype.getBoundingClientRect = () => ({
			width: 800,
			height: 600,
			top: 0,
			left: 0,
			right: 800,
			bottom: 600,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
	});

	afterEach(() => {
		cleanup();
	});

	it("renders only a window of 2000 entries in the DOM", async () => {
		const {container} = render(
			<LogList
				entries={makeEntries(2000)}
				containerRef={{current: null}}
				onScroll={() => {}}
				isFollowing={false}
			/>,
		);
		await waitFor(() => {
			expect(container.querySelectorAll("li").length).toBeGreaterThan(0);
		});
		expect(container.querySelectorAll("li").length).toBeLessThan(100);
	});
});
