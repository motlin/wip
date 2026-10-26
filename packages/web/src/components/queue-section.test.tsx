// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";

import {CATEGORY_PRIORITY} from "../lib/category-actions.js";
import {QueueSection} from "./queue-section.js";

function cards(n: number): () => React.ReactNode[] {
	return () => Array.from({length: n}, (_, i) => <div key={i}>card {i}</div>);
}

describe("QueueSection", () => {
	afterEach(() => {
		cleanup();
	});

	it("collapses the On hold section to a count until the user opens it", () => {
		render(<QueueSection category="snoozed" count={2} cards={cards(2)} />);
		const collapsed = {
			heading: screen.getByRole("heading").textContent,
			cards: screen.queryAllByText(/^card /).length,
		};

		fireEvent.click(screen.getByRole("button", {name: "Show 2 on hold"}));

		expect({
			collapsed,
			expanded: screen.getAllByText(/^card /).map((node) => node.textContent),
		}).toStrictEqual({
			collapsed: {heading: `${CATEGORY_PRIORITY.indexOf("snoozed") + 1} Snoozed2`, cards: 0},
			expanded: ["card 0", "card 1"],
		});
	});

	it("shows an ordinary section's cards at once", () => {
		render(<QueueSection category="ready_to_test" count={1} cards={cards(1)} />);

		expect({
			cards: screen.getAllByText(/^card /).map((node) => node.textContent),
			toggle: screen.queryByRole("button"),
		}).toStrictEqual({cards: ["card 0"], toggle: null});
	});
});
