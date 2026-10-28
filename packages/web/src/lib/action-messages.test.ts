import {describe, expect, it} from "vite-plus/test";

import {actionEventToast, actionResultToast, taskEventToast} from "./action-messages.js";

describe("actionEventToast", () => {
	it("says in plain words what is waiting and for what, never the internal action name", () => {
		expect(
			actionEventToast({
				id: "action-1",
				project: "wip",
				label: "createPr",
				target: "Add work queue",
				status: "waiting",
				waitingFor: "test",
			}),
		).toStrictEqual({
			level: "info",
			message: "Opening a pull request for Add work queue…",
			detail: "Waiting for a test run in wip to finish",
		});
	});

	it("names the project when the action has no target", () => {
		expect(
			actionEventToast({id: "action-2", project: "wip", label: "commitWorkingTree", status: "waiting"}),
		).toStrictEqual({
			level: "info",
			message: "Committing your changes in wip…",
			detail: undefined,
		});
	});

	it("explains a busy repo in plain words", () => {
		expect(
			actionEventToast({
				id: "action-3",
				project: "wip",
				label: "mergePr",
				target: "PR #12",
				status: "busy",
				waitingFor: "AI conflict rung",
			}),
		).toStrictEqual({
			level: "error",
			message: "Couldn't start merging the pull request for PR #12: wip is busy",
			detail: "Claude resolving conflicts is still running; try again shortly",
		});
	});

	it("falls back to a generic phrase for an unknown action and job", () => {
		expect(
			actionEventToast({
				id: "action-4",
				project: "wip",
				label: "someNewThing",
				status: "waiting",
				waitingFor: "x",
			}),
		).toStrictEqual({
			level: "info",
			message: "Running an action in wip…",
			detail: "Waiting for another job in wip to finish",
		});
	});

	it("shows nothing for running and done", () => {
		expect([
			actionEventToast({id: "a", project: "wip", label: "createPr", status: "running"}),
			actionEventToast({id: "a", project: "wip", label: "createPr", status: "done"}),
		]).toStrictEqual([null, null]);
	});
});

describe("actionResultToast", () => {
	it("links an opened PR to GitHub", () => {
		expect(
			actionResultToast("Open PR", {
				ok: true,
				message: "Opened PR #123",
				prNumber: 123,
				prUrl: "https://github.com/motlin/wip/pull/123",
			}),
		).toStrictEqual({
			level: "success",
			message: "Opened PR #123",
			link: {href: "https://github.com/motlin/wip/pull/123", label: "View on GitHub"},
		});
	});

	it("links a compare URL when there is no PR", () => {
		expect(
			actionResultToast("Push", {
				ok: true,
				message: "Pushed feature/x to upstream",
				compareUrl: "https://github.com/motlin/wip/compare/feature/x?expand=1",
			}),
		).toStrictEqual({
			level: "success",
			message: "Pushed feature/x to upstream",
			link: {href: "https://github.com/motlin/wip/compare/feature/x?expand=1", label: "View on GitHub"},
		});
	});

	it("shows a plain success message with no link otherwise", () => {
		expect(actionResultToast("Rename branch", {ok: true, message: "Renamed a → b"})).toStrictEqual({
			level: "success",
			message: "Renamed a → b",
		});
	});

	it("reports a failure with the first line of the reason and a link to the log", () => {
		expect(
			actionResultToast("Open PR", {
				ok: false,
				message: "Failed to fetch upstream/main: fatal: could not read\nmore detail\n",
			}),
		).toStrictEqual({
			level: "error",
			message: "Open PR failed",
			detail: "Failed to fetch upstream/main: fatal: could not read",
			link: {href: "/debug/logs", label: "See the log"},
		});
	});
});

describe("taskEventToast", () => {
	const base = {id: "1", sha: "a".repeat(40), project: "wip", shortSha: "aaaaaaa", subject: "Add work queue"};

	it("links a finished push to the GitHub compare page", () => {
		expect(
			taskEventToast({
				...base,
				taskType: "push",
				status: "passed",
				branch: "feature/x",
				message: "Pushed feature/x to upstream",
				compareUrl: "https://github.com/motlin/wip/compare/feature/x?expand=1",
			}),
		).toStrictEqual({
			level: "success",
			message: "Pushed feature/x to upstream",
			link: {href: "https://github.com/motlin/wip/compare/feature/x?expand=1", label: "View on GitHub"},
		});
	});

	it("links a failed push or rebase to its log", () => {
		expect([
			taskEventToast({...base, taskType: "push", status: "failed", message: "Failed to push feature/x"}),
			taskEventToast({...base, taskType: "rebase", status: "failed", message: "feature/x: rebase conflicts"}),
		]).toStrictEqual([
			{
				level: "error",
				message: "Push failed",
				detail: "Failed to push feature/x",
				link: {href: `/log/wip/${base.sha}`, label: "See the log"},
			},
			{
				level: "error",
				message: "Rebase failed",
				detail: "feature/x: rebase conflicts",
				link: {href: `/log/wip/${base.sha}`, label: "See the log"},
			},
		]);
	});

	it("says when a Claude task finishes or fails and points at the Tasks page", () => {
		expect([
			taskEventToast({...base, taskType: "claude", status: "passed"}),
			taskEventToast({...base, taskType: "claude", status: "failed", message: "claude exited 1"}),
		]).toStrictEqual([
			{level: "success", message: 'Finished "Add work queue"', link: {href: "/tasks", label: "See tasks"}},
			{
				level: "error",
				message: 'Couldn\'t finish "Add work queue"',
				detail: "claude exited 1",
				link: {href: "/tasks", label: "See tasks"},
			},
		]);
	});

	it("shows nothing while a task is still queued or running, or for test tasks", () => {
		expect([
			taskEventToast({...base, taskType: "push", status: "running"}),
			taskEventToast({...base, taskType: "test", status: "passed"}),
		]).toStrictEqual([null, null]);
	});
});
