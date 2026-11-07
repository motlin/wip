import {describe, it, expect} from "vite-plus/test";

import {getOwnershipOrgs} from "./config.js";
import type {GitChildResult} from "./schemas.js";
import {
	isOwnUpstreamRed,
	markUpstreamRed,
	stopsLine,
	upstreamOwnership,
	upstreamRedCommand,
	upstreamRedFailures,
} from "./upstream-red.js";

const identity = {login: "motlin", orgs: ["liftwizard", "Acme-Org"]};

function makeUpstreamCi(overrides: Partial<GitChildResult> = {}): GitChildResult {
	return {
		kind: "upstream_ci",
		project: "test",
		remote: "motlin/test",
		originRemote: "origin",
		sha: "abc123",
		shortSha: "abc",
		subject: "Fix failing CI on upstream/main",
		date: "2026-01-01",
		branch: "main",
		skippable: false,
		pushedToRemote: true,
		testStatus: "unknown",
		checkStatus: "failed",
		reviewStatus: "no_pr",
		prUrl: "https://github.com/motlin/test/actions",
		...overrides,
	};
}

describe("upstreamOwnership", () => {
	it("is own when the upstream owner is the user's login", () => {
		expect(upstreamOwnership("motlin/wip", identity)).toBe("own");
	});

	it("is own when the upstream owner is one of the user's orgs, ignoring case", () => {
		expect(upstreamOwnership("acme-org/thing", identity)).toBe("own");
	});

	it("is foreign for any other owner", () => {
		expect(upstreamOwnership("someone-else/lib", identity)).toBe("foreign");
	});

	it("with the default ownership orgs, is own for motlin and liftwizard and foreign for eclipse-collections", () => {
		const defaultIdentity = {login: "motlin", orgs: getOwnershipOrgs({})};
		expect({
			motlin: upstreamOwnership("motlin/wip", defaultIdentity),
			liftwizard: upstreamOwnership("liftwizard/liftwizard", defaultIdentity),
			eclipseCollections: upstreamOwnership("eclipse-collections/eclipse-collections", defaultIdentity),
		}).toStrictEqual({motlin: "own", liftwizard: "own", eclipseCollections: "foreign"});
	});
});

describe("stopsLine", () => {
	it("is true for an own red upstream", () => {
		expect(stopsLine({upstreamRed: true, ownership: "own"})).toBe(true);
	});

	it("is false for a foreign red upstream", () => {
		expect(stopsLine({upstreamRed: true, ownership: "foreign"})).toBe(false);
	});

	it("is false for an own green upstream", () => {
		expect(stopsLine({upstreamRed: false, ownership: "own"})).toBe(false);
	});
});

describe("upstreamRedCommand", () => {
	it("suggests /github:gha for red upstream CI", () => {
		expect(upstreamRedCommand(makeUpstreamCi())).toBe("/github:gha");
	});

	it("suggests /build:fix for a red local baseline", () => {
		expect(upstreamRedCommand(makeUpstreamCi({testStatus: "failed", checkStatus: "none"}))).toBe("/build:fix");
	});
});

describe("upstreamRedFailures", () => {
	it("names the failing check runs on the upstream tip", () => {
		expect(
			upstreamRedFailures(
				makeUpstreamCi({failedChecks: [{name: "build"}, {name: "lint", url: "https://x.test/1"}]}),
			),
		).toStrictEqual(["build", "lint"]);
	});

	it("names a red local baseline when no check failed", () => {
		expect(upstreamRedFailures(makeUpstreamCi({testStatus: "failed", checkStatus: "none"}))).toStrictEqual([
			"local baseline test failed",
		]);
	});
});

describe("markUpstreamRed", () => {
	const commit: GitChildResult = {...makeUpstreamCi(), kind: undefined, sha: "def456", subject: "Add a feature"};

	it("marks an own red upstream's item and blocks the repo's commits", () => {
		const {kind: _kind, ...plain} = commit;
		expect(markUpstreamRed([makeUpstreamCi(), plain], "own")).toStrictEqual([
			makeUpstreamCi({ownership: "own"}),
			{...plain, upstreamRedBlocked: true},
		]);
	});

	it("marks a foreign red upstream's item and blocks nothing", () => {
		const {kind: _kind, ...plain} = commit;
		expect(markUpstreamRed([makeUpstreamCi(), plain], "foreign")).toStrictEqual([
			makeUpstreamCi({ownership: "foreign"}),
			plain,
		]);
	});

	it("leaves a green upstream's commits alone", () => {
		const {kind: _kind, ...plain} = commit;
		expect(markUpstreamRed([plain], "own")).toStrictEqual([plain]);
	});
});

describe("isOwnUpstreamRed", () => {
	it("is true only for an own upstream_ci child", () => {
		expect({
			own: isOwnUpstreamRed(makeUpstreamCi({ownership: "own"})),
			foreign: isOwnUpstreamRed(makeUpstreamCi({ownership: "foreign"})),
			unmarked: isOwnUpstreamRed(makeUpstreamCi()),
		}).toStrictEqual({own: true, foreign: false, unmarked: false});
	});
});
