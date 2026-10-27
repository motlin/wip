import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {QueryClient, dehydrate} from "@tanstack/react-query";
import type {PersistedClient} from "@tanstack/react-query-persist-client";
import {
	PERSIST_KEY,
	PERSIST_THROTTLE_MS,
	createThrottledStoragePersister,
	setupQueryPersistence,
	shouldPersistQuery,
} from "./query-persistence.js";

class MemoryStorage {
	readonly items = new Map<string, string>();
	setItemCalls = 0;
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.setItemCalls++;
		this.items.set(key, value);
	}
	removeItem(key: string): void {
		this.items.delete(key);
	}
}

function persistedClient(label: string): PersistedClient {
	return {timestamp: 1, buster: label, clientState: {mutations: [], queries: []}};
}

describe("createThrottledStoragePersister", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes at most once per throttle window, with the latest client", async () => {
		const storage = new MemoryStorage();
		const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});

		await persister.persistClient(persistedClient("a"));
		await persister.persistClient(persistedClient("b"));
		await persister.persistClient(persistedClient("c"));
		expect({calls: storage.setItemCalls, stored: storage.items.get(PERSIST_KEY)}).toStrictEqual({
			calls: 0,
			stored: undefined,
		});

		vi.advanceTimersByTime(PERSIST_THROTTLE_MS);
		expect({calls: storage.setItemCalls, stored: storage.items.get(PERSIST_KEY)}).toStrictEqual({
			calls: 1,
			stored: JSON.stringify(persistedClient("c")),
		});

		vi.advanceTimersByTime(PERSIST_THROTTLE_MS * 3);
		expect(storage.setItemCalls).toBe(1);
	});

	it("flush writes the pending client immediately and cancels the timer", async () => {
		const storage = new MemoryStorage();
		const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});

		await persister.persistClient(persistedClient("a"));
		persister.flush();
		vi.advanceTimersByTime(PERSIST_THROTTLE_MS);
		persister.flush();

		expect({calls: storage.setItemCalls, stored: storage.items.get(PERSIST_KEY)}).toStrictEqual({
			calls: 1,
			stored: JSON.stringify(persistedClient("a")),
		});
	});

	it("restores the stored client and removes it", async () => {
		const storage = new MemoryStorage();
		storage.items.set(PERSIST_KEY, JSON.stringify(persistedClient("saved")));
		const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});

		expect(await persister.restoreClient()).toStrictEqual(persistedClient("saved"));
		await persister.removeClient();
		expect(await persister.restoreClient()).toBeUndefined();
	});

	it("ignores a stored value that is not a persisted client", async () => {
		const storage = new MemoryStorage();
		storage.items.set(PERSIST_KEY, JSON.stringify({clientState: null}));
		const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});

		expect(await persister.restoreClient()).toBeUndefined();
	});

	it("drops the stored cache when a write fails, instead of keeping a stale one", async () => {
		const storage = new MemoryStorage();
		storage.items.set(PERSIST_KEY, "old");
		storage.setItem = () => {
			throw new Error("QuotaExceededError");
		};
		const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});

		await persister.persistClient(persistedClient("a"));
		persister.flush();

		expect(storage.items.get(PERSIST_KEY)).toBeUndefined();
	});
});

describe("setupQueryPersistence", () => {
	it("restores the saved cache, then saves only persistable queries when the page hides", async () => {
		const storage = new MemoryStorage();
		const saved = new QueryClient();
		saved.setQueryData(["projects"], [{name: "wip"}]);
		storage.items.set(
			PERSIST_KEY,
			JSON.stringify({timestamp: Date.now(), buster: "b1", clientState: dehydrate(saved)}),
		);
		const page = new EventTarget();
		const queryClient = new QueryClient();

		await setupQueryPersistence({queryClient, storage, page, buster: "b1"});
		const restored = queryClient.getQueryData(["projects"]);
		queryClient.setQueryData(["ladderResults"], [{project: "wip"}]);
		queryClient.setQueryData(["todos", "wip"], [{id: 1}]);
		page.dispatchEvent(new Event("pagehide"));

		const written = JSON.parse(storage.items.get(PERSIST_KEY) ?? "null") as PersistedClient;
		expect({
			restored,
			calls: storage.setItemCalls,
			keys: written.clientState.queries.map((q) => q.queryKey),
		}).toStrictEqual({restored: [{name: "wip"}], calls: 1, keys: [["projects"], ["todos", "wip"]]});
	});
});

describe("shouldPersistQuery", () => {
	it("persists successful view data and skips polled, on-demand, registry and failed queries", async () => {
		const queryClient = new QueryClient();
		for (const key of [
			["projects"],
			["children", "wip"],
			["todos", "wip"],
			["projectItems"],
			["ladderResults"],
			["systemStatus"],
			["taskQueue"],
			["diff", "wip", "abc"],
			["testLog", "wip", "abc"],
			["workingTreeDiff", "wip"],
			["inventoryStatus"],
			["registryCandidates"],
		]) {
			queryClient.setQueryData(key, {});
		}
		await queryClient
			.query({
				queryKey: ["issues"],
				queryFn: async () => Promise.reject(new Error("boom")),
				retry: false,
			})
			.catch(() => undefined);

		const persisted = dehydrate(queryClient, {shouldDehydrateQuery: shouldPersistQuery}).queries.map(
			(q) => q.queryKey,
		);

		expect(persisted).toStrictEqual([["projects"], ["children", "wip"], ["todos", "wip"], ["projectItems"]]);
	});
});
