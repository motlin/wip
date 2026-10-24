import type {Query, QueryClient} from "@tanstack/react-query";
import {persistQueryClient} from "@tanstack/react-query-persist-client";
import type {PersistedClient, Persister} from "@tanstack/react-query-persist-client";

export const PERSIST_KEY = "REACT_QUERY_OFFLINE_CACHE";

/**
 * The persister serializes the whole cache (~750 KB of JSON) on every write.
 * With the library's 1 s default, polling and SSE updates rewrote it every few
 * seconds for the life of the tab. The cache only exists to paint a reload
 * quickly, so a write every 30 s, plus a flush when the tab is hidden, is enough.
 */
export const PERSIST_THROTTLE_MS = 30_000;

// Polled or live-pushed state is refetched on load anyway, and diffs and test
// logs are fetched on demand and pile up over a session; none of them help paint.
// The registry status and review rows mirror projects.json5, which a save from any
// tab rewrites; a restored copy painted pre-save decisions as still undecided, and a
// stale tab's throttled write could overwrite the saving tab's fresh copy.
const UNPERSISTED_KEYS: ReadonlySet<unknown> = new Set([
	"inventoryStatus",
	"registryCandidates",
	"ladderResults",
	"systemStatus",
	"taskQueue",
	"runAllCounts",
	"diff",
	"testLog",
	"workingTreeDiff",
]);

export function shouldPersistQuery(query: Query): boolean {
	return query.state.status === "success" && !UNPERSISTED_KEYS.has(query.queryKey[0]);
}

interface SyncStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface ThrottledPersister extends Persister {
	/** Writes the pending client now, if any. */
	flush: () => void;
}

function isPersistedClient(value: unknown): value is PersistedClient {
	return (
		typeof value === "object" &&
		value !== null &&
		"timestamp" in value &&
		typeof value.timestamp === "number" &&
		"buster" in value &&
		typeof value.buster === "string" &&
		"clientState" in value &&
		typeof value.clientState === "object" &&
		value.clientState !== null
	);
}

/** A localStorage persister that keeps only the latest client and writes it at most once per window. */
export function createThrottledStoragePersister({
	storage,
	throttleMs,
	key = PERSIST_KEY,
}: {
	storage: SyncStorage;
	throttleMs: number;
	key?: string;
}): ThrottledPersister {
	let pending: PersistedClient | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function flush(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (pending === undefined) return;
		const client = pending;
		pending = undefined;
		try {
			storage.setItem(key, JSON.stringify(client));
		} catch {
			// Over quota: a stale cache would paint wrong data, so drop it.
			storage.removeItem(key);
		}
	}

	return {
		persistClient(client) {
			pending = client;
			timer ??= setTimeout(flush, throttleMs);
		},
		restoreClient() {
			const raw = storage.getItem(key);
			if (raw === null) return undefined;
			const parsed: unknown = JSON.parse(raw);
			return isPersistedClient(parsed) ? parsed : undefined;
		},
		removeClient() {
			pending = undefined;
			storage.removeItem(key);
		},
		flush,
	};
}

/**
 * Restores the persisted cache into queryClient and keeps it saved. Resolves
 * once restored. A hidden tab may be discarded without warning, so the pending
 * write is flushed when the page hides rather than waiting out the throttle.
 */
export async function setupQueryPersistence({
	queryClient,
	storage,
	page,
	buster,
}: {
	queryClient: QueryClient;
	storage: SyncStorage;
	page: EventTarget;
	buster: string;
}): Promise<void> {
	const persister = createThrottledStoragePersister({storage, throttleMs: PERSIST_THROTTLE_MS});
	page.addEventListener("pagehide", persister.flush);
	page.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") persister.flush();
	});
	const [, restored] = persistQueryClient({
		queryClient,
		persister,
		buster,
		dehydrateOptions: {shouldDehydrateQuery: shouldPersistQuery},
	});
	await restored;
}
