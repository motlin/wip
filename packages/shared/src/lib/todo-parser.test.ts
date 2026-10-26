import {describe, it, expect} from "vite-plus/test";

import {parseTodoContent} from "./todo-parser.js";

describe("parseTodoContent", () => {
	it("marks [!] tasks blocked and leaves [ ] and [x] unblocked", () => {
		const content = "- [ ] open\n- [x] done\n- [!] x\n  why it is blocked\n";
		expect(parseTodoContent(content, "todo.md")).toStrictEqual([
			{text: "open", completed: false, blocked: false, sourceFile: "todo.md", contextLines: []},
			{text: "done", completed: true, blocked: false, sourceFile: "todo.md", contextLines: []},
			{text: "x", completed: false, blocked: true, sourceFile: "todo.md", contextLines: ["why it is blocked"]},
		]);
	});
});
