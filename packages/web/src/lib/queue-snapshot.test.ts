import {describe, it, expect} from "vite-plus/test";
import {QueryClient} from "@tanstack/react-query";
import type {TodoItem} from "@wip/shared";
import {applyQueueSnapshot, isQueueCacheWarm} from "./queue-snapshot.js";
import {
	issuesQueryOptions,
	projectChildrenQueryOptions,
	projectItemsQueryOptions,
	projectTodosQueryOptions,
	snoozedQueryOptions,
} from "./queries.js";
import type {QueueSnapshot} from "./server-fns.js";
import {makeChild} from "./test-factories.js";

const todo: TodoItem = {
	project: "alpha",
	title: "Alpha todo",
	sourceFile: "/a/.llm/todo.md",
	sourceLabel: ".llm/todo.md",
};
const child = makeChild({project: "alpha", subject: "Alpha child"});

const snapshot: QueueSnapshot = {
	children: {alpha: [child]},
	todos: {alpha: [todo], beta: []},
	issues: [],
	projectItems: null,
	snoozed: [],
};

function cacheEntries(queryClient: QueryClient) {
	return {
		alphaChildren: queryClient.getQueryData(projectChildrenQueryOptions("alpha").queryKey),
		betaChildren: queryClient.getQueryData(projectChildrenQueryOptions("beta").queryKey),
		alphaTodos: queryClient.getQueryData(projectTodosQueryOptions("alpha").queryKey),
		betaTodos: queryClient.getQueryData(projectTodosQueryOptions("beta").queryKey),
		issues: queryClient.getQueryData(issuesQueryOptions().queryKey),
		projectItems: queryClient.getQueryData(projectItemsQueryOptions().queryKey),
		snoozed: queryClient.getQueryData(snoozedQueryOptions().queryKey),
	};
}

describe("applyQueueSnapshot", () => {
	it("fans the snapshot into the per-key caches and skips absent entries", () => {
		const queryClient = new QueryClient();

		applyQueueSnapshot(queryClient, snapshot);

		expect(cacheEntries(queryClient)).toStrictEqual({
			alphaChildren: [child],
			betaChildren: undefined,
			alphaTodos: [todo],
			betaTodos: [],
			issues: [],
			projectItems: undefined,
			snoozed: [],
		});
	});
});

describe("isQueueCacheWarm", () => {
	const projects = ["alpha"];

	it("is warm once every queue key has fresh data", () => {
		const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: 60_000}}});
		applyQueueSnapshot(queryClient, {...snapshot, projectItems: []});

		expect(isQueueCacheWarm(queryClient, projects)).toBe(true);
	});

	it("is cold when a project's children are missing", () => {
		const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: 60_000}}});
		applyQueueSnapshot(queryClient, {...snapshot, children: {}, projectItems: []});

		expect(isQueueCacheWarm(queryClient, projects)).toBe(false);
	});

	it("is cold when a project's todos are stale", () => {
		const queryClient = new QueryClient({defaultOptions: {queries: {staleTime: 60_000}}});
		applyQueueSnapshot(queryClient, {...snapshot, projectItems: []});
		queryClient.setQueryData(projectTodosQueryOptions("alpha").queryKey, [todo], {updatedAt: Date.now() - 120_000});

		expect(isQueueCacheWarm(queryClient, projects)).toBe(false);
	});
});
