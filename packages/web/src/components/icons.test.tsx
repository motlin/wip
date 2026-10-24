// @vitest-environment jsdom
import {afterEach, describe, expect, it} from "vite-plus/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {cleanup, render} from "@testing-library/react";
import * as Icons from "./icons.js";
import {GitBranch, GitHubIcon, IconSprite, Loader2} from "./icons.js";

afterEach(() => {
	cleanup();
});

describe("sprite icons", () => {
	it("render a reference into the shared sprite instead of inline icon geometry", () => {
		const {container} = render(
			<>
				<GitBranch className="h-4 w-4" />
				<Loader2 className="h-3 w-3 animate-spin" />
			</>,
		);

		expect(container.innerHTML).toBe(
			'<svg class="h-4 w-4" width="24" height="24" aria-hidden="true"><use href="#icon-git-branch"></use></svg>' +
				'<svg class="h-3 w-3 animate-spin" width="24" height="24" aria-hidden="true"><use href="#icon-loader-2"></use></svg>',
		);
	});

	it("renders the GitHub mark as a sprite reference too", () => {
		const {container} = render(<GitHubIcon className="h-3.5 w-3.5" />);

		expect(container.innerHTML).toBe(
			'<svg class="h-3.5 w-3.5" width="24" height="24" aria-hidden="true"><use href="#icon-github"></use></svg>',
		);
	});

	it("the sprite defines every icon exactly once, each with geometry", () => {
		const {container} = render(<IconSprite />);

		const symbols = [...container.querySelectorAll("symbol")];
		const ids = symbols.map((s) => s.id);
		expect(ids.length).toBe(new Set(ids).size);
		expect(symbols.filter((s) => s.querySelector("path, circle, line, rect, polyline") === null)).toStrictEqual([]);
	});

	it("every exported icon references a symbol the sprite defines", () => {
		const {container} = render(
			<>
				<IconSprite />
				{Object.entries(Icons)
					.filter(([name]) => name !== "IconSprite")
					.map(([name, Icon]) => (
						<Icon key={name} />
					))}
			</>,
		);

		const defined = new Set([...container.querySelectorAll("symbol")].map((s) => `#${s.id}`));
		const references = [...container.querySelectorAll("use")].map((u) => u.getAttribute("href"));
		expect(references.length).toBe(41);
		expect(references.filter((href) => href === null || !defined.has(href))).toStrictEqual([]);
		expect(defined.size).toBe(41);
	});

	it("many cards' icons add no geometry beyond the sprite's single definition", () => {
		const {container} = render(
			<>
				<IconSprite />
				{Array.from({length: 50}, (_, i) => (
					<GitBranch key={i} className="h-4 w-4" />
				))}
			</>,
		);

		const geometryOutsideSprite = [...container.querySelectorAll("path, circle")].filter(
			(el) => el.closest("symbol") === null,
		);
		expect(geometryOutsideSprite).toStrictEqual([]);
	});
});

describe("icon imports", () => {
	it("only icons.tsx imports lucide-react, so every icon goes through the sprite", () => {
		const srcDir = path.resolve(__dirname, "..");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) files.push(full);
			}
		};
		walk(srcDir);

		const importers = files
			.filter((file) => /from\s+["']lucide-react["']/.test(fs.readFileSync(file, "utf-8")))
			.map((file) => path.relative(srcDir, file));
		expect(importers).toStrictEqual(["components/icons.tsx"]);
	});
});
