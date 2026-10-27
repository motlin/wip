import {describe, it, expect} from "vite-plus/test";

import {type BackgroundPush, type CheckRunStatus, GitHubActionsGate, pushGateDecision} from "./gha-gate.js";

const first: BackgroundPush = {repository: "motlin/wip", sha: "aaa111", pushedAt: 1_000};
const second: BackgroundPush = {repository: "motlin/other", sha: "bbb222", pushedAt: 2_000};

function fakeChecks(statuses: Record<string, CheckRunStatus[]>) {
	const calls: BackgroundPush[] = [];
	return {
		calls,
		statuses,
		source: async (push: BackgroundPush): Promise<CheckRunStatus[]> => {
			calls.push(push);
			return Promise.resolve(statuses[push.sha] ?? []);
		},
	};
}

describe("pushGateDecision", () => {
	it("is open when there was no background push", () => {
		expect(pushGateDecision(undefined, [], 5_000)).toStrictEqual({open: true});
	});

	it("holds while any check on the last background push is queued", () => {
		expect(pushGateDecision(first, ["in_progress", "queued", "completed"], 5_000)).toStrictEqual({
			open: false,
			reason: "GitHub Actions queued on motlin/wip@aaa111",
		});
	});

	it("opens once every check has left the queue", () => {
		expect(pushGateDecision(first, ["in_progress", "completed"], 5_000)).toStrictEqual({open: true});
	});

	it("holds while a fresh push has no checks registered yet, and opens after the grace window", () => {
		expect(pushGateDecision(first, [], first.pushedAt + 30_000)).toStrictEqual({
			open: false,
			reason: "Waiting for GitHub Actions to register checks on motlin/wip@aaa111",
		});
		expect(pushGateDecision(first, [], first.pushedAt + 60_000)).toStrictEqual({open: true});
	});
});

describe("GitHubActionsGate", () => {
	it("holds a second push while the first has a queued check and releases it once the check runs", async () => {
		const checks = fakeChecks({aaa111: ["queued"]});
		const gate = new GitHubActionsGate(checks.source, () => 5_000);

		expect(await gate.check()).toStrictEqual({open: true});
		gate.recordPush(first);

		expect(await gate.check()).toStrictEqual({
			open: false,
			reason: "GitHub Actions queued on motlin/wip@aaa111",
		});

		checks.statuses["aaa111"] = ["in_progress"];
		expect(await gate.check()).toStrictEqual({open: true});
		gate.recordPush(second);

		expect(checks.calls).toStrictEqual([first, first]);
	});

	it("gates on the most recent background push across repos", async () => {
		const checks = fakeChecks({aaa111: ["completed"], bbb222: ["queued"]});
		const gate = new GitHubActionsGate(checks.source, () => 5_000);
		gate.recordPush(first);
		gate.recordPush(second);

		expect(await gate.check()).toStrictEqual({
			open: false,
			reason: "GitHub Actions queued on motlin/other@bbb222",
		});
		expect(checks.calls).toStrictEqual([second]);
	});

	it("stays held when the checks source fails", async () => {
		const gate = new GitHubActionsGate(
			async () => Promise.reject(new Error("rate limited")),
			() => 5_000,
		);
		gate.recordPush(first);

		expect(await gate.check()).toStrictEqual({
			open: false,
			reason: "GitHub Actions status unavailable for motlin/wip@aaa111: rate limited",
		});
	});
});
