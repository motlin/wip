import {describe, expect, it} from "vite-plus/test";
import {isGreen, isLandable, readinessOf, type Readiness, type ReadinessCommit} from "./readiness.js";

const UPSTREAM = "1111111111111111111111111111111111111111";
const STALE = "2222222222222222222222222222222222222222";

function commit(overrides: Partial<ReadinessCommit>): ReadinessCommit {
	return {
		parentSha: UPSTREAM,
		testStatus: "unknown",
		hasTestConfigured: true,
		onHold: false,
		...overrides,
	};
}

describe("isLandable", () => {
	it.each([
		{name: "no_test commit on the tip", input: commit({hasTestConfigured: false}), expected: true},
		{name: "green commit on the tip", input: commit({testStatus: "passed"}), expected: true},
		{name: "untested commit on the tip", input: commit({}), expected: false},
		{name: "failed commit on the tip", input: commit({testStatus: "failed"}), expected: false},
		{
			name: "no_test commit on a stale parent",
			input: commit({hasTestConfigured: false, parentSha: STALE}),
			expected: false,
		},
		{
			name: "on-hold no_test commit on the tip",
			input: commit({hasTestConfigured: false, onHold: true}),
			expected: false,
		},
	])("$name -> $expected", ({input, expected}) => {
		expect(isLandable(input, UPSTREAM)).toBe(expected);
	});
});

const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccccccccccccccccccc";

describe("readinessOf", () => {
	it.each<{name: string; graph: Record<string, ReadinessCommit>; expected: Record<string, Readiness>}>([
		{
			name: "green commit on the tip",
			graph: {[A]: commit({testStatus: "passed"})},
			expected: {[A]: "landable"},
		},
		{
			name: "green commit on a stale parent",
			graph: {[A]: commit({testStatus: "passed", parentSha: STALE})},
			expected: {[A]: "not_ready"},
		},
		{
			name: "no_test commit on the tip",
			graph: {[A]: commit({hasTestConfigured: false})},
			expected: {[A]: "landable"},
		},
		{
			name: "on-hold green commit on the tip",
			graph: {[A]: commit({testStatus: "passed", onHold: true})},
			expected: {[A]: "not_ready"},
		},
		{
			name: "green stack on a landable parent",
			graph: {
				[A]: commit({testStatus: "passed"}),
				[B]: commit({testStatus: "passed", parentSha: A}),
				[C]: commit({testStatus: "passed", parentSha: B}),
			},
			expected: {[A]: "landable", [B]: "ready_stacked", [C]: "ready_stacked"},
		},
		{
			name: "green stacked commit on an unverified parent",
			graph: {
				[A]: commit({}),
				[B]: commit({testStatus: "passed", parentSha: A}),
			},
			expected: {[A]: "not_ready", [B]: "not_ready"},
		},
		{
			name: "untested stacked commit on a landable parent",
			graph: {
				[A]: commit({testStatus: "passed"}),
				[B]: commit({parentSha: A}),
				[C]: commit({testStatus: "passed", parentSha: B}),
			},
			expected: {[A]: "landable", [B]: "not_ready", [C]: "not_ready"},
		},
		{
			name: "green stacked commit on an on-hold parent",
			graph: {
				[A]: commit({testStatus: "passed", onHold: true}),
				[B]: commit({testStatus: "passed", parentSha: A}),
			},
			expected: {[A]: "not_ready", [B]: "not_ready"},
		},
		{
			name: "on-hold green commit on a landable parent",
			graph: {
				[A]: commit({testStatus: "passed"}),
				[B]: commit({testStatus: "passed", parentSha: A, onHold: true}),
			},
			expected: {[A]: "landable", [B]: "not_ready"},
		},
		{
			name: "no_test commit stacked on a landable parent",
			graph: {
				[A]: commit({testStatus: "passed"}),
				[B]: commit({hasTestConfigured: false, parentSha: A}),
			},
			expected: {[A]: "landable", [B]: "ready_stacked"},
		},
		{
			name: "green commit whose parent is outside the graph and not the tip",
			graph: {[B]: commit({testStatus: "passed", parentSha: A})},
			expected: {[B]: "not_ready"},
		},
	])("$name", ({graph, expected}) => {
		expect(Object.fromEntries(readinessOf(new Map(Object.entries(graph)), UPSTREAM))).toStrictEqual(expected);
	});
});

describe("isGreen with the patch-id fast path", () => {
	it.each([
		{
			name: "local test skipped, PR checks passed",
			input: commit({localTestSkipped: true, checkStatus: "passed"}),
			expected: true,
		},
		{
			name: "local test skipped, PR checks pending",
			input: commit({localTestSkipped: true, checkStatus: "pending"}),
			expected: false,
		},
		{name: "local test skipped, PR checks unknown", input: commit({localTestSkipped: true}), expected: false},
		{
			name: "local test skipped, no tests configured, checks pending",
			input: commit({localTestSkipped: true, hasTestConfigured: false, checkStatus: "pending"}),
			expected: false,
		},
		{name: "PR checks passed without the fast path", input: commit({checkStatus: "passed"}), expected: false},
	])("$name -> $expected", ({input, expected}) => {
		expect(isGreen(input)).toBe(expected);
	});
});
