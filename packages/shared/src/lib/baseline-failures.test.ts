import {describe, expect, it} from "vite-plus/test";

import {parseFailedTests, withinBaseline} from "./baseline-failures.js";

describe("parseFailedTests", () => {
	it("reads per-test failures from vitest, jest, surefire, cargo, pytest, go and TAP logs", () => {
		const log = [
			"\u001b[31m FAIL \u001b[39m src/a.test.ts > parser > reads a line",
			" ✓ src/b.test.ts (3 tests) 12ms",
			"  ● Suite › handles empty input",
			"[ERROR] com.example.FooTest.bar -- Time elapsed: 0.012 s <<< FAILURE!",
			"[ERROR] baz(com.example.FooTest)  Time elapsed: 0.01 sec  <<< ERROR!",
			"[ERROR]   FooTest.bar:42 expected:<1> but was:<2>",
			"test net::tests::connects ... FAILED",
			"test net::tests::resolves ... ok",
			"FAILED tests/test_x.py::test_y - AssertionError: boom",
			"--- FAIL: TestQuux (0.00s)",
			"not ok 3 - tap case",
			"ok 4 - passing tap case",
		].join("\n");

		expect(parseFailedTests(log)).toStrictEqual(
			new Set([
				"src/a.test.ts > parser > reads a line",
				"Suite › handles empty input",
				"com.example.FooTest.bar",
				"baz(com.example.FooTest)",
				"net::tests::connects",
				"tests/test_x.py::test_y",
				"TestQuux",
				"tap case",
			]),
		);
	});

	it("is null when the log names no failing test (a build error, or a cached result with no detail)", () => {
		expect({
			buildError: parseFailedTests("error[E0425]: cannot find value `x`\nerror: could not compile"),
			cached: parseFailedTests("Tree abc^{tree} is already known to be bad for test 'default'!"),
			empty: parseFailedTests(""),
		}).toStrictEqual({buildError: null, cached: null, empty: null});
	});
});

describe("withinBaseline", () => {
	const baseline = new Set(["a", "b"]);

	it("accepts a commit whose failures are all baseline failures, and rejects one new failure", () => {
		expect({
			subset: withinBaseline(baseline, new Set(["a"])),
			same: withinBaseline(baseline, new Set(["a", "b"])),
			newFailure: withinBaseline(baseline, new Set(["a", "c"])),
		}).toStrictEqual({subset: true, same: true, newFailure: false});
	});

	it("rejects when either side's failures are unknown", () => {
		expect({
			commitUnknown: withinBaseline(baseline, null),
			baselineUnknown: withinBaseline(null, new Set(["a"])),
		}).toStrictEqual({commitUnknown: false, baselineUnknown: false});
	});
});
