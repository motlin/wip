import {describe, expect, it} from "vite-plus/test";
import {isLandable, type ReadinessCommit} from "./readiness.js";

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
