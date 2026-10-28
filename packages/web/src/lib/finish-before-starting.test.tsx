// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, render, screen} from "@testing-library/react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import type {TodoItem} from "@wip/shared";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";

import {QueueCards} from "../components/queue-cards.js";
import {commitsWaiting} from "./finish-before-starting.js";
import {emptyGrouped} from "./grouping.js";
import {QueueContext, type QueueContextValue} from "./queue-context.js";

vi.mock("./server-fns", () => ({
	runTodoTask: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	snoozeTodoFn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
	unsnoozeTodoFn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

const EMPTY_STATE: ReadyToLandState = {slots: 2, ready: [], inFlight: [], next: [], stoppedProjects: []};
const ITEM = {id: "p1", project: "wip", sha: "a".repeat(40)};

describe("commitsWaiting", () => {
	it.each([
		{name: "nothing waiting", counts: {red: 0, ready: 0}, state: EMPTY_STATE, expected: false},
		{name: "no buffer state yet", counts: {red: 0, ready: 0}, state: undefined, expected: false},
		{name: "a red commit", counts: {red: 1, ready: 0}, state: EMPTY_STATE, expected: true},
		{name: "a ready commit", counts: {red: 0, ready: 1}, state: undefined, expected: true},
		{
			name: "a buffered ready commit",
			counts: {red: 0, ready: 0},
			state: {...EMPTY_STATE, ready: [ITEM]},
			expected: true,
		},
		{
			name: "a commit being readied in the buffer",
			counts: {red: 0, ready: 0},
			state: {...EMPTY_STATE, inFlight: [ITEM]},
			expected: true,
		},
	])("$name -> $expected", ({counts, state, expected}) => {
		expect(commitsWaiting(counts, state)).toBe(expected);
	});
});

const todo: TodoItem = {
	project: "wip",
	title: "Write the docs",
	sourceFile: "/repo/wip/.llm/todo.md",
	sourceLabel: ".llm/todo.md",
};

function contextFor(waiting: boolean): QueueContextValue {
	return {
		grouped: {...emptyGrouped(), triaged: {todos: [todo]}},
		totalCount: 1,
		readyToTestCount: 0,
		needsRebaseCount: 0,
		projectCount: 1,
		selectedCategory: null,
		selectedProject: null,
		filterByProject: (items) => items,
		visibleCategories: ["triaged"],
		commitsWaiting: waiting,
	};
}

function renderQueue(waiting: boolean) {
	const context = contextFor(waiting);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<QueueContext.Provider value={context}>
				<QueueCards />
			</QueueContext.Provider>
		</QueryClientProvider>,
	);
}

const startButton = () => screen.getByRole("button", {name: "Do this task"});

describe("finish before starting", () => {
	afterEach(() => {
		cleanup();
	});

	it("de-emphasises the todo start action, keeps it enabled, and shows the message while commits wait", () => {
		renderQueue(true);

		expect({
			variant: startButton().getAttribute("data-variant"),
			disabled: (startButton() as HTMLButtonElement).disabled,
			filled: startButton().className.includes("bg-purple-600"),
			message: screen.queryByTestId("finish-before-starting")?.textContent,
		}).toStrictEqual({
			variant: "secondary",
			disabled: false,
			filled: false,
			message: "Commits are waiting: finish before starting a todo",
		});
	});

	it("keeps the todo start action primary with no message when no commits wait", () => {
		renderQueue(false);

		expect({
			variant: startButton().getAttribute("data-variant"),
			disabled: (startButton() as HTMLButtonElement).disabled,
			filled: startButton().className.includes("bg-purple-600"),
			message: screen.queryByTestId("finish-before-starting"),
		}).toStrictEqual({variant: "primary", disabled: false, filled: true, message: null});
	});
});
