// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {act, cleanup, render, screen} from "@testing-library/react";

import {Toaster} from "./toaster.js";
import {clearToasts, pushToast} from "../lib/toast-store.js";

afterEach(() => {
	cleanup();
	clearToasts();
});

describe("Toaster", () => {
	it("renders a toast's link so the user can find the result", () => {
		render(<Toaster />);
		act(() => {
			pushToast({
				level: "success",
				message: "Opened PR #123",
				link: {href: "https://github.com/motlin/wip/pull/123", label: "View on GitHub"},
			});
		});

		const link = screen.getByRole("link", {name: "View on GitHub"});
		expect({
			text: screen.getByText("Opened PR #123").textContent,
			href: link.getAttribute("href"),
			target: link.getAttribute("target"),
		}).toStrictEqual({
			text: "Opened PR #123",
			href: "https://github.com/motlin/wip/pull/123",
			target: "_blank",
		});
	});

	it("opens in-app links in the same tab", () => {
		render(<Toaster />);
		act(() => {
			pushToast({
				level: "error",
				message: "Push failed",
				link: {href: "/log/wip/abc", label: "See the log"},
			});
		});

		const link = screen.getByRole("link", {name: "See the log"});
		expect({href: link.getAttribute("href"), target: link.getAttribute("target")}).toStrictEqual({
			href: "/log/wip/abc",
			target: null,
		});
	});
});
