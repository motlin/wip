import {describe, expect, it} from "vite-plus/test";
import type {BackgroundPush, PushGateDecision} from "@wip/shared";

import {createBackgroundPusher, publishAfterAdvance, type PushRequest} from "./background-push.js";

const SHA = "a".repeat(40);
const OLD = "b".repeat(40);

const request: PushRequest = {project: "wip", dir: "/p/wip", repository: "motlin/wip", branch: "feature", sha: SHA};

function fakes(options: {remoteSha?: string; gate?: PushGateDecision[]; pushExit?: number} = {}) {
	const commands: string[][] = [];
	const recorded: BackgroundPush[] = [];
	const decisions = [...(options.gate ?? [])];
	const pusher = createBackgroundPusher({
		gate: {
			check: async () => Promise.resolve(decisions.shift() ?? {open: true}),
			recordPush: (push) => {
				recorded.push(push);
			},
		},
		git: async (args) => {
			commands.push([...args]);
			if (args.includes("rev-parse")) {
				return Promise.resolve(
					options.remoteSha === undefined
						? {exitCode: 1, stdout: "", stderr: ""}
						: {exitCode: 0, stdout: `${options.remoteSha}\n`, stderr: ""},
				);
			}
			return Promise.resolve({exitCode: options.pushExit ?? 0, stdout: "", stderr: "rejected"});
		},
		now: () => 5_000,
	});
	return {pusher, commands, recorded};
}

const REV_PARSE = ["-C", "/p/wip", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature"];
const PUSH = ["-C", "/p/wip", "push", "--force-with-lease", "origin", "feature:feature"];

describe("publishAfterAdvance", () => {
	it("force-pushes a ready pull-request-repo candidate once with lease and records it on the gate", async () => {
		const {pusher, commands, recorded} = fakes({remoteSha: OLD});
		const outcome = await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		expect({outcome, commands, recorded, pending: pusher.pending()}).toStrictEqual({
			outcome: {status: "pushed"},
			commands: [REV_PARSE, PUSH],
			recorded: [{repository: "motlin/wip", sha: SHA, pushedAt: 5_000}],
			pending: [],
		});
	});

	it("never pushes in a fast-forward repo", async () => {
		const {pusher, commands} = fakes({remoteSha: OLD});
		const outcome = await publishAfterAdvance({landing: "fast-forward", outcome: "ready", request}, pusher);
		expect({outcome, commands}).toStrictEqual({outcome: null, commands: []});
	});

	it("never pushes an item that is not ready", async () => {
		const {pusher, commands} = fakes({remoteSha: OLD});
		const outcomes = [];
		for (const outcome of ["test_failed", "rebase_conflicts", "checks_pending", "skipped"] as const) {
			// eslint-disable-next-line no-await-in-loop
			outcomes.push(await publishAfterAdvance({landing: "pull-request", outcome, request}, pusher));
		}
		expect({outcomes, commands}).toStrictEqual({outcomes: [null, null, null, null], commands: []});
	});

	it("skips the push when origin already has the sha", async () => {
		const {pusher, commands, recorded} = fakes({remoteSha: SHA});
		const outcome = await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		expect({outcome, commands, recorded}).toStrictEqual({
			outcome: {status: "up_to_date"},
			commands: [REV_PARSE],
			recorded: [],
		});
	});

	it("defers the push while the gate is held, and pushes it once the gate opens", async () => {
		const {pusher, commands, recorded} = fakes({
			remoteSha: OLD,
			gate: [{open: false, reason: "GitHub Actions queued on motlin/other@ccc"}, {open: true}],
		});
		const held = await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		const afterHeld = {commands: [...commands], pending: pusher.pending()};
		await pusher.flush();
		expect({held, afterHeld, commands, recorded, pending: pusher.pending()}).toStrictEqual({
			held: {status: "held", reason: "GitHub Actions queued on motlin/other@ccc"},
			afterHeld: {commands: [REV_PARSE], pending: [request]},
			commands: [REV_PARSE, REV_PARSE, PUSH],
			recorded: [{repository: "motlin/wip", sha: SHA, pushedAt: 5_000}],
			pending: [],
		});
	});

	it("drops a deferred push when the branch's next advance is not ready", async () => {
		const {pusher, commands} = fakes({
			remoteSha: OLD,
			gate: [{open: false, reason: "held"}],
		});
		await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		await publishAfterAdvance({landing: "pull-request", outcome: "test_failed", request}, pusher);
		await pusher.flush();
		expect({commands, pending: pusher.pending()}).toStrictEqual({commands: [REV_PARSE], pending: []});
	});
});

describe("publishAfterAdvance with an unaccepted AI fixup", () => {
	it("never pushes a ready item whose auto-fix awaits review, and drops its deferred push", async () => {
		const {pusher, commands} = fakes({remoteSha: OLD, gate: [{open: false, reason: "held"}]});
		await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		const outcome = await publishAfterAdvance(
			{landing: "pull-request", outcome: "ready", request, autoFixed: true},
			pusher,
		);
		await pusher.flush();
		expect({outcome, commands, pending: pusher.pending()}).toStrictEqual({
			outcome: null,
			commands: [REV_PARSE],
			pending: [],
		});
	});

	it("pushes once after the fix is accepted and the item is ready again", async () => {
		const {pusher, commands, recorded} = fakes({remoteSha: OLD});
		const unaccepted = await publishAfterAdvance(
			{landing: "pull-request", outcome: "ready", request, autoFixed: true},
			pusher,
		);
		const accepted = await publishAfterAdvance({landing: "pull-request", outcome: "ready", request}, pusher);
		expect({unaccepted, accepted, commands, recorded}).toStrictEqual({
			unaccepted: null,
			accepted: {status: "pushed"},
			commands: [REV_PARSE, PUSH],
			recorded: [{repository: "motlin/wip", sha: SHA, pushedAt: 5_000}],
		});
	});
});

describe("createBackgroundPusher", () => {
	it("does not defer a push asked without deferral (the patch-id fast path) when the gate is held", async () => {
		const {pusher, commands} = fakes({remoteSha: OLD, gate: [{open: false, reason: "held"}]});
		const outcome = await pusher.push(request, {defer: false});
		expect({outcome, commands, pending: pusher.pending()}).toStrictEqual({
			outcome: {status: "held", reason: "held"},
			commands: [REV_PARSE],
			pending: [],
		});
	});

	it("reports a rejected push as failed without recording it on the gate", async () => {
		const {pusher, recorded} = fakes({remoteSha: OLD, pushExit: 1});
		expect({outcome: await pusher.push(request, {defer: true}), recorded}).toStrictEqual({
			outcome: {status: "failed", stderr: "rejected"},
			recorded: [],
		});
	});

	it("serializes pushes, so a second push sees the gate after the first one recorded", async () => {
		const order: string[] = [];
		let last: BackgroundPush | undefined;
		const pusher = createBackgroundPusher({
			gate: {
				check: async () => {
					order.push("check");
					return Promise.resolve(
						last === undefined ? {open: true} : {open: false, reason: `held on ${last.sha.slice(0, 1)}`},
					);
				},
				recordPush: (push) => {
					order.push("record");
					last = push;
				},
			},
			git: async (args) =>
				Promise.resolve({exitCode: args.includes("rev-parse") ? 1 : 0, stdout: "", stderr: ""}),
			now: () => 1,
		});
		const outcomes = await Promise.all([
			pusher.push(request, {defer: true}),
			pusher.push({...request, branch: "other", sha: OLD}, {defer: true}),
		]);
		expect({outcomes, order}).toStrictEqual({
			outcomes: [{status: "pushed"}, {status: "held", reason: "held on a"}],
			order: ["check", "record", "check"],
		});
	});
});
