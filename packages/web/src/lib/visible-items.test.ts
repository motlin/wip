import {describe, it, expect} from "vite-plus/test";

import {limitVisibleItems, SECTION_PAGE_SIZE} from "./visible-items";

describe("limitVisibleItems", () => {
	it("renders only the first page of a large section until expanded", () => {
		const items = Array.from({length: 1768}, (_, i) => `card-${i}`);

		const visible = limitVisibleItems(items, SECTION_PAGE_SIZE, false);

		expect(visible).toStrictEqual(items.slice(0, SECTION_PAGE_SIZE));
	});

	it("renders every item once the section is expanded", () => {
		const items = Array.from({length: 1768}, (_, i) => `card-${i}`);

		const visible = limitVisibleItems(items, SECTION_PAGE_SIZE, true);

		expect(visible).toStrictEqual(items);
	});

	it("renders every item when the section is within the page size", () => {
		const items = ["a", "b", "c"];

		expect(limitVisibleItems(items, SECTION_PAGE_SIZE, false)).toStrictEqual(["a", "b", "c"]);
	});

	it("renders an empty list for an empty section", () => {
		expect(limitVisibleItems([], SECTION_PAGE_SIZE, false)).toStrictEqual([]);
	});
});
