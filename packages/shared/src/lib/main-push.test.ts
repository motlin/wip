import {describe, expect, it} from "vite-plus/test";
import {afterPush, greenPrefix, visiblePushes, type MainPushCommit} from "./main-push.js";

const commit = (n: number, status: MainPushCommit["status"]): MainPushCommit => ({
	sha: String(n).repeat(40).slice(0, 40),
	subject: `Commit ${n}`,
	status,
});

describe("greenPrefix", () => {
	it("pushes every commit when all are green", () => {
		const commits = [commit(1, "good"), commit(2, "good"), commit(3, "good")];
		expect(greenPrefix(commits)).toStrictEqual({green: commits, rest: [], next: undefined});
	});

	it("stops before an unknown HEAD and names it as the next commit to test", () => {
		const commits = [commit(1, "good"), commit(2, "good"), commit(3, "unknown")];
		expect(greenPrefix(commits)).toStrictEqual({
			green: [commits[0], commits[1]],
			rest: [commits[2]],
			next: commits[2],
		});
	});

	it("stops at a red commit in the middle, keeping the green commits after it unpushed with nothing to test", () => {
		const commits = [commit(1, "good"), commit(2, "bad"), commit(3, "good"), commit(4, "unknown")];
		expect(greenPrefix(commits)).toStrictEqual({
			green: [commits[0]],
			rest: [commits[1], commits[2], commits[3]],
			next: undefined,
		});
	});

	it("has an empty green prefix when the oldest commit is unknown", () => {
		const commits = [commit(1, "unknown"), commit(2, "good")];
		expect(greenPrefix(commits)).toStrictEqual({green: [], rest: commits, next: commits[0]});
	});
});

const push = (project: string, commits: MainPushCommit[]) => ({
	project,
	remote: "origin",
	branch: "main",
	diverged: false,
	commits,
});

describe("afterPush", () => {
	it("drops the pushed commits from the project's row and keeps the unpushed tail", () => {
		const tail = commit(3, "unknown");
		const pushes = [push("a", [commit(1, "good"), commit(2, "good"), tail]), push("b", [commit(4, "good")])];
		expect(afterPush(pushes, "a", commit(2, "good").sha)).toStrictEqual([push("a", [tail]), pushes[1]]);
	});

	it("removes the project's row when everything was pushed", () => {
		const pushes = [push("a", [commit(1, "good")])];
		expect(afterPush(pushes, "a", commit(1, "good").sha)).toStrictEqual([]);
	});
});

describe("visiblePushes", () => {
	it("keeps a diverged main, a non-empty green prefix, or a running test, and drops an idle main with nothing green", () => {
		const idle = push("idle", [commit(1, "unknown")]);
		const green = push("green", [commit(2, "good"), commit(3, "bad")]);
		const testing = {...push("testing", [commit(4, "unknown")]), testing: commit(4, "unknown").sha};
		const diverged = {...push("diverged", []), diverged: true};
		expect(visiblePushes([idle, green, testing, diverged])).toStrictEqual([green, testing, diverged]);
	});
});
