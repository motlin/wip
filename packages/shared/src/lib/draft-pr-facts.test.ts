import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {execa} from "execa";
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {
	hasPullRequestTrigger,
	readDraftPrRepoFacts,
	readPullRequestWorkflows,
	resetDraftPrRepoFactsCache,
} from "./draft-pr-facts.js";
import {getViewerPermission, resetViewerPermissionCache} from "./github-viewer-permission.js";
import {resetGitHubRateLimit} from "./rate-limit.js";
import {resetGitHubClient, setGitHubClient} from "../services/github-client.js";

describe("hasPullRequestTrigger", () => {
	it("finds a pull_request trigger in each YAML spelling of on:", () => {
		expect({
			scalar: hasPullRequestTrigger("on: pull_request\njobs: {}\n"),
			list: hasPullRequestTrigger("on: [push, pull_request]\n"),
			map: hasPullRequestTrigger("on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n"),
			typed: hasPullRequestTrigger("on:\n  pull_request:\n    types: [opened, synchronize]\n"),
		}).toStrictEqual({scalar: true, list: true, map: true, typed: true});
	});

	it("ignores pull_request in expressions, comments and pull_request_target", () => {
		expect({
			expression: hasPullRequestTrigger(
				"on: push\njobs:\n  a:\n    if: github.event.pull_request.draft == false\n",
			),
			eventName: hasPullRequestTrigger("on: push\njobs:\n  a:\n    if: github.event_name == 'pull_request'\n"),
			comment: hasPullRequestTrigger("on: push # not pull_request\n"),
			target: hasPullRequestTrigger("on: pull_request_target\n"),
		}).toStrictEqual({expression: false, eventName: false, comment: false, target: false});
	});
});

async function gitIn(dir: string, ...args: string[]): Promise<string> {
	return (await execa("git", ["-C", dir, ...args])).stdout.trim();
}

async function repoWithWorkflows(files: Record<string, string>): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-draft-pr-facts-"));
	await gitIn(dir, "init", "-q", "-b", "main");
	await gitIn(dir, "config", "user.email", "test@example.com");
	await gitIn(dir, "config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "x\n");
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.join(dir, ".github", "workflows"), {recursive: true});
		fs.writeFileSync(path.join(dir, ".github", "workflows", name), text);
	}
	await gitIn(dir, "add", "-A");
	await gitIn(dir, "commit", "-q", "-m", "init");
	return dir;
}

describe("readPullRequestWorkflows", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
	});

	it("reads the workflows committed on the ref, not the working tree", async () => {
		const withPr = await repoWithWorkflows({"ci.yml": "on: [push, pull_request]\n", "notes.md": "pull_request"});
		const pushOnly = await repoWithWorkflows({"ci.yaml": "on: push\n"});
		const none = await repoWithWorkflows({});
		dirs.push(withPr, pushOnly, none);
		fs.writeFileSync(path.join(pushOnly, ".github", "workflows", "ci.yaml"), "on: pull_request\n");
		expect({
			withPr: await readPullRequestWorkflows(withPr, "main"),
			pushOnly: await readPullRequestWorkflows(pushOnly, "main"),
			none: await readPullRequestWorkflows(none, "main"),
		}).toStrictEqual({withPr: true, pushOnly: false, none: false});
	});
});

describe("readDraftPrRepoFacts", () => {
	const dirs: string[] = [];
	let queries = 0;
	let isPrivate: boolean | Error = false;
	let viewerPermission: string | null = "WRITE";

	beforeEach(() => {
		resetGitHubRateLimit();
		resetDraftPrRepoFactsCache();
		queries = 0;
		isPrivate = false;
		viewerPermission = "WRITE";
		resetViewerPermissionCache();
		setGitHubClient({
			graphql: async () => {
				queries += 1;
				if (isPrivate instanceof Error) throw isPrivate;
				return Promise.resolve({data: {repository: {isPrivate, viewerPermission}}});
			},
		});
	});

	afterEach(() => {
		resetGitHubClient();
		for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
	});

	it("combines the repo's visibility with its pull_request workflows, asking GitHub once per repo", async () => {
		const dir = await repoWithWorkflows({"ci.yml": "on: pull_request\n"});
		dirs.push(dir);
		isPrivate = false;
		const first = await readDraftPrRepoFacts(dir, "main", "alice/repo", false);
		const second = await readDraftPrRepoFacts(dir, "main", "alice/repo", false);
		expect({first, second, queries}).toStrictEqual({
			first: {repository: "alice/repo", isPrivate: false, hasPullRequestWorkflows: true, tokenShortfall: null},
			second: {repository: "alice/repo", isPrivate: false, hasPullRequestWorkflows: true, tokenShortfall: null},
			queries: 1,
		});
	});

	it("is unknown (null, not cached) when GitHub can't say", async () => {
		const dir = await repoWithWorkflows({"ci.yml": "on: pull_request\n"});
		dirs.push(dir);
		isPrivate = new Error("boom");
		const failed = await readDraftPrRepoFacts(dir, "main", "alice/repo", false);
		isPrivate = true;
		const retried = await readDraftPrRepoFacts(dir, "main", "alice/repo", false);
		expect({failed, retried, queries}).toStrictEqual({
			failed: null,
			retried: {repository: "alice/repo", isPrivate: true, hasPullRequestWorkflows: true, tokenShortfall: null},
			queries: 2,
		});
	});

	it("reads whether the token can open PRs with a head branch in the repo, and seeds Open PR's permission cache", async () => {
		const dir = await repoWithWorkflows({"ci.yml": "on: pull_request\n"});
		dirs.push(dir);
		viewerPermission = "READ";
		const sameRepo = await readDraftPrRepoFacts(dir, "main", "org/repo", false);
		const fromFork = await readDraftPrRepoFacts(dir, "main", "org/repo", true);
		const permission = await getViewerPermission("org/repo");
		expect({sameRepo, fromFork, permission, queries}).toStrictEqual({
			sameRepo: {
				repository: "org/repo",
				isPrivate: false,
				hasPullRequestWorkflows: true,
				tokenShortfall: "read-only",
			},
			fromFork: {repository: "org/repo", isPrivate: false, hasPullRequestWorkflows: true, tokenShortfall: null},
			permission: "READ",
			queries: 2,
		});
	});
});
