// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {TodoItem} from "@wip/shared";

import {TodoCard} from "./todo-card.js";
import {clearToasts} from "../lib/toast-store.js";

const serverFns = vi.hoisted(() => ({
	runTodoTask: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	snoozeTodoFn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	unsnoozeTodoFn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../lib/server-fns", () => serverFns);

const todo: TodoItem = {
	project: "wip",
	title: "Write the docs",
	sourceFile: "/repo/wip/.llm/todo.md",
	sourceLabel: ".llm/todo.md",
};
const other: TodoItem = {...todo, title: "Another task"};

function renderTodo(item: TodoItem) {
	const queryClient = new QueryClient();
	queryClient.setQueryData(["todos", "wip"], [item, other]);
	render(
		<QueryClientProvider client={queryClient}>
			<TodoCard todo={item} category="triaged" />
		</QueryClientProvider>,
	);
	return queryClient;
}

const primaryButtons = () => screen.getAllByRole("button").filter((button) => button.hasAttribute("data-primary"));

describe("TodoCard actions", () => {
	afterEach(() => {
		cleanup();
		clearToasts();
		for (const fn of Object.values(serverFns)) fn.mockReset();
	});

	it("renders Do this task as its one primary action, naming the todo, and queues that todo", async () => {
		serverFns.runTodoTask.mockResolvedValue({id: "t1", status: "queued", message: "queued"});
		renderTodo(todo);

		expect(
			primaryButtons().map((button) => ({label: button.textContent, title: button.getAttribute("title")})),
		).toStrictEqual([
			{
				label: "Do this task",
				title: 'Run claude with markdown-tasks:do-one-task on "Write the docs" from .llm/todo.md in wip',
			},
		]);
		fireEvent.click(primaryButtons()[0]!);

		await waitFor(() => {
			expect(serverFns.runTodoTask.mock.calls).toStrictEqual([
				[{data: {project: "wip", sourceFile: "/repo/wip/.llm/todo.md", title: "Write the docs"}}],
			]);
		});
	});

	it("puts the todo On hold from More and writes the hold into the todos cache", async () => {
		serverFns.snoozeTodoFn.mockResolvedValue({ok: true, message: "On hold"});
		const queryClient = renderTodo(todo);

		fireEvent.click(screen.getByRole("button", {name: "More"}));
		fireEvent.click(screen.getByRole("button", {name: "On hold"}));

		await waitFor(() => {
			expect(queryClient.getQueryData(["todos", "wip"])).toStrictEqual([{...todo, onHold: true}, other]);
		});
		expect(serverFns.snoozeTodoFn.mock.calls).toStrictEqual([
			[{data: {project: "wip", sourceFile: "/repo/wip/.llm/todo.md", title: "Write the docs", until: null}}],
		]);
	});

	it("offers Unsnooze on a todo on hold and clears the hold in the cache", async () => {
		serverFns.unsnoozeTodoFn.mockResolvedValue({ok: true, message: "Unsnoozed"});
		const held = {...todo, onHold: true};
		const queryClient = renderTodo(held);

		fireEvent.click(screen.getByRole("button", {name: "More"}));
		fireEvent.click(screen.getByRole("button", {name: "Unsnooze"}));

		await waitFor(() => {
			expect(queryClient.getQueryData(["todos", "wip"])).toStrictEqual([{...todo, onHold: false}, other]);
		});
		expect(serverFns.unsnoozeTodoFn.mock.calls).toStrictEqual([
			[{data: {project: "wip", sourceFile: "/repo/wip/.llm/todo.md", title: "Write the docs"}}],
		]);
	});
});
