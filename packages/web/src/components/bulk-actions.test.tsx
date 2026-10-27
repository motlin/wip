// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";

import {BulkActions} from "./bulk-actions.js";
import type {EscapeHatchRecipe} from "../lib/escape-hatch.js";

afterEach(() => {
	cleanup();
});

function setup(running = true) {
	const calls: string[] = [];
	render(
		<BulkActions
			topUp={async () => {
				calls.push("top-up");
				return Promise.resolve({running});
			}}
			runRecipe={async (recipe: EscapeHatchRecipe) => {
				calls.push(`recipe:${recipe}`);
				return Promise.resolve();
			}}
		/>,
	);
	return calls;
}

const buttonNames = (): string[] => screen.getAllByRole("button").map((b) => b.textContent);

describe("BulkActions", () => {
	it("offers Top up ready buffer as the primary action, with no per-item Rebase All or Test All button", () => {
		setup();

		expect(buttonNames()).toStrictEqual(["Top up ready buffer", "More"]);
	});

	it("tops up the buffer on click", async () => {
		const calls = setup();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Top up ready buffer"}));
			await Promise.resolve();
		});

		expect({calls, status: screen.queryByRole("status")?.textContent ?? null}).toStrictEqual({
			calls: ["top-up"],
			status: null,
		});
	});

	it("says so when the buffer is not running in this server", async () => {
		setup(false);

		await act(async () => {
			fireEvent.click(screen.getByRole("button", {name: "Top up ready buffer"}));
			await Promise.resolve();
		});

		expect(screen.getByRole("status").textContent).toBe("The ready buffer is not running in this server");
	});

	it("lists the just recipes in the More menu and runs the one clicked", async () => {
		const calls = setup();

		fireEvent.click(screen.getByRole("button", {name: "More"}));
		const items = screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label"));
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", {name: "Rebase all (just rebase-all)"}));
			await Promise.resolve();
		});

		expect({items, calls, menuOpen: screen.queryByRole("menu") !== null}).toStrictEqual({
			items: [
				"Git all (just g)",
				"Rebase all (just rebase-all)",
				"Replay all (just replay-all)",
				"Test all (just ta)",
			],
			calls: ["recipe:rebase-all"],
			menuOpen: false,
		});
	});
});
