/**
 * Baseline-relative acceptance for a foreign red upstream (lean plan step 35). git-test stores only
 * pass/fail per commit, so per-test failures come from the run's log file: each recognised runner
 * format names its failing tests. A commit on a foreign red upstream is acceptable when every test
 * it fails also fails on the baseline. A log that names no failing test (a build error, or git-test
 * answering from a cached result) yields null, which never proves a subset.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const PATTERNS: readonly RegExp[] = [
	// vitest: " FAIL  src/a.test.ts > describe > test"
	/^FAIL\s+(.+)$/,
	// jest: "● Suite › test"
	/^●\s+(.+›.+)$/,
	// surefire: "[ERROR] com.x.FooTest.bar -- Time elapsed: ... <<< FAILURE!" and the older "bar(com.x.FooTest)  Time elapsed"
	/^\[ERROR\]\s+(.+?)\s+(?:--\s+)?Time elapsed:.*<<<\s*(?:FAILURE|ERROR)!$/,
	// cargo: "test mod::name ... FAILED"
	/^test\s+(\S+)\s+\.\.\.\s+FAILED$/,
	// pytest: "FAILED tests/test_x.py::test_y - message"
	/^FAILED\s+(\S+)/,
	// go: "--- FAIL: TestX (0.00s)"
	/^--- FAIL:\s+(\S+)/,
	// TAP: "not ok 3 - name"
	/^not ok\s+\d+\s+-\s+(.+)$/,
];

/** The failing tests the log names; null when it names none. */
export function parseFailedTests(log: string): ReadonlySet<string> | null {
	const failed = new Set<string>();
	for (const raw of log.split("\n")) {
		const line = raw.replace(ANSI_RE, "").trim();
		for (const pattern of PATTERNS) {
			const name = pattern.exec(line)?.[1]?.trim();
			if (name) {
				failed.add(name);
				break;
			}
		}
	}
	return failed.size === 0 ? null : failed;
}

/** True when every failure is a baseline failure; unknown failures on either side never are. */
export function withinBaseline(baseline: ReadonlySet<string> | null, failures: ReadonlySet<string> | null): boolean {
	if (baseline === null || failures === null) return false;
	return [...failures].every((name) => baseline.has(name));
}
