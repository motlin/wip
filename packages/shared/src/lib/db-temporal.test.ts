import {describe, it, expect, beforeEach, afterEach, vi} from "vite-plus/test";

import {sql} from "drizzle-orm";

import {
	initDb,
	resetDb,
	getDb,
	setBranchName,
	getBranchName,
	cacheUpstreamSha,
	getCachedUpstreamSha,
	cacheMergeStatus,
	getCachedMergeStatuses,
	setAdvanceConfig,
	getAdvanceConfig,
} from "./db.js";
import {FAR_FUTURE} from "./schema.js";

interface TemporalRow {
	system_from: string;
	system_to: string;
}

const T0 = "2025-01-01 00:00:00.000";
const T1 = "2025-01-01 00:01:00.000";

beforeEach(() => {
	initDb(":memory:");
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
});

afterEach(() => {
	vi.useRealTimers();
	resetDb();
});

function rowsOf(table: string): TemporalRow[] {
	return getDb().all(sql.raw(`SELECT system_from, system_to FROM ${table}`)) as TemporalRow[];
}

describe("setBranchName temporal upsert", () => {
	it("inserts an initial live row", () => {
		setBranchName("abc123", "test-project", "feature/foo");

		const rows = rowsOf("branch_names");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
		expect(getBranchName("abc123", "test-project")).toBe("feature/foo");
	});

	it("early-returns when the value is unchanged", () => {
		setBranchName("abc123", "test-project", "feature/foo");
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		setBranchName("abc123", "test-project", "feature/foo");

		const rows = rowsOf("branch_names");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
	});

	it("closes the old row and inserts a new one when the value changes", () => {
		setBranchName("abc123", "test-project", "feature/foo");
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		setBranchName("abc123", "test-project", "feature/bar");

		const rows = rowsOf("branch_names");
		expect(rows).toHaveLength(2);
		const closed = rows.find((r) => r.system_to !== FAR_FUTURE);
		const live = rows.find((r) => r.system_to === FAR_FUTURE);
		expect(closed).toStrictEqual({system_from: T0, system_to: T1});
		expect(live).toStrictEqual({system_from: T1, system_to: FAR_FUTURE});
		expect(getBranchName("abc123", "test-project")).toBe("feature/bar");
	});
});

describe("cacheUpstreamSha temporal upsert", () => {
	it("inserts an initial live row", () => {
		cacheUpstreamSha("test-project", "upstream/main", "abc123");

		const rows = rowsOf("upstream_refs");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
		expect(getCachedUpstreamSha("test-project")).toBe("abc123");
	});

	it("early-returns when ref and sha are unchanged", () => {
		cacheUpstreamSha("test-project", "upstream/main", "abc123");
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		cacheUpstreamSha("test-project", "upstream/main", "abc123");

		const rows = rowsOf("upstream_refs");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
	});

	it("closes the old row and inserts a new one when the sha changes", () => {
		cacheUpstreamSha("test-project", "upstream/main", "abc123");
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		cacheUpstreamSha("test-project", "upstream/main", "def456");

		const rows = rowsOf("upstream_refs");
		expect(rows).toHaveLength(2);
		const closed = rows.find((r) => r.system_to !== FAR_FUTURE);
		const live = rows.find((r) => r.system_to === FAR_FUTURE);
		expect(closed).toStrictEqual({system_from: T0, system_to: T1});
		expect(live).toStrictEqual({system_from: T1, system_to: FAR_FUTURE});
		expect(getCachedUpstreamSha("test-project")).toBe("def456");
	});
});

describe("cacheMergeStatus temporal upsert", () => {
	it("inserts an initial live row", () => {
		cacheMergeStatus("test-project", "abc123", "up-sha", 3, 1, true);

		const rows = rowsOf("merge_status");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
		expect(getCachedMergeStatuses("test-project", "up-sha")).toHaveLength(1);
	});

	it("early-returns when all fields are unchanged (including null rebaseable)", () => {
		cacheMergeStatus("test-project", "abc123", "up-sha", 3, 1, null);
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		cacheMergeStatus("test-project", "abc123", "up-sha", 3, 1, null);

		const rows = rowsOf("merge_status");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
	});

	it("closes the old row and inserts a new one when a field changes", () => {
		cacheMergeStatus("test-project", "abc123", "up-sha", 3, 1, true);
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		cacheMergeStatus("test-project", "abc123", "up-sha", 3, 5, true);

		const rows = rowsOf("merge_status");
		expect(rows).toHaveLength(2);
		const closed = rows.find((r) => r.system_to !== FAR_FUTURE);
		const live = rows.find((r) => r.system_to === FAR_FUTURE);
		expect(closed).toStrictEqual({system_from: T0, system_to: T1});
		expect(live).toStrictEqual({system_from: T1, system_to: FAR_FUTURE});
		expect(getCachedMergeStatuses("test-project", "up-sha")[0]!.commitsBehind).toBe(5);
	});
});

describe("setAdvanceConfig temporal upsert", () => {
	it("inserts an initial live row", () => {
		setAdvanceConfig("test-project", 4);

		const rows = rowsOf("advance_config");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
		expect(getAdvanceConfig("test-project")).toBe(4);
	});

	it("early-returns when concurrency is unchanged", () => {
		setAdvanceConfig("test-project", 4);
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		setAdvanceConfig("test-project", 4);

		const rows = rowsOf("advance_config");
		expect(rows).toStrictEqual([{system_from: T0, system_to: FAR_FUTURE}]);
	});

	it("closes the old row and inserts a new one when concurrency changes", () => {
		setAdvanceConfig("test-project", 4);
		vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
		setAdvanceConfig("test-project", 8);

		const rows = rowsOf("advance_config");
		expect(rows).toHaveLength(2);
		const closed = rows.find((r) => r.system_to !== FAR_FUTURE);
		const live = rows.find((r) => r.system_to === FAR_FUTURE);
		expect(closed).toStrictEqual({system_from: T0, system_to: T1});
		expect(live).toStrictEqual({system_from: T1, system_to: FAR_FUTURE});
		expect(getAdvanceConfig("test-project")).toBe(8);
	});
});
