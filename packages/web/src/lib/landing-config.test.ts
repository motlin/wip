import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {
	initDb,
	loadInventory,
	resetDb,
	resetGitHubClient,
	setGitHubClient,
	type ProjectInfo,
	type ProjectRecord,
} from "@wip/shared";

import {
	getActionsBillingBlockHandler,
	landByPushingHandler,
	resetProjectCache,
	seedProjectCache,
} from "./server-fns.impl.js";
import {useTempConfigHome} from "./temp-registry.js";

function makeProject(name: string): ProjectInfo {
	return {
		name,
		dir: `/nonexistent/${name}`,
		remote: `motlin/${name}`,
		originRemote: `motlin/${name}`,
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 0,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
}

const secret: ProjectRecord = {name: "secret", dir: "/nonexistent/secret", template: "typescript", kind: "own"};
const other: ProjectRecord = {name: "other", dir: "/nonexistent/other", template: "java", kind: "fork"};

let temp: ReturnType<typeof useTempConfigHome>;

beforeEach(() => {
	initDb(":memory:");
	seedProjectCache([makeProject("secret"), makeProject("other"), makeProject("stray")]);
	temp = useTempConfigHome([secret, other]);
});

afterEach(() => {
	resetGitHubClient();
	resetProjectCache();
	resetDb();
	temp.restore();
});

describe("landByPushingHandler", () => {
	it("configures only that repo to land by pushing directly", async () => {
		const result = await landByPushingHandler({project: "secret"});
		expect({result, projects: loadInventory().projects}).toStrictEqual({
			result: {ok: true, message: "secret now lands by pushing directly: Fast-forward main, then Push main"},
			projects: [other, {...secret, landing: "fast-forward"}],
		});
	});

	it("refuses a project the registry doesn't list, and writes nothing", async () => {
		const result = await landByPushingHandler({project: "stray"});
		expect({result, projects: loadInventory().projects}).toStrictEqual({
			result: {ok: false, message: "stray isn't in the registry; add it on the Registry page first"},
			projects: [other, secret],
		});
	});
});

describe("landByPushingHandler with an invalid registry entry", () => {
	it("refuses rather than drop the entry it can't read", async () => {
		const fs = await import("node:fs");
		const {getInventoryPath} = await import("@wip/shared");
		const raw = `[${JSON.stringify(secret)}, {"name": "broken"}]`;
		fs.writeFileSync(getInventoryPath(), raw);
		const result = await landByPushingHandler({project: "secret"});
		expect({result, raw: fs.readFileSync(getInventoryPath(), "utf8")}).toStrictEqual({
			result: {
				ok: false,
				message: `The registry at ${getInventoryPath()} has 1 invalid entry; fix it before changing secret's landing`,
			},
			raw,
		});
	});
});

function respond(response: unknown): void {
	setGitHubClient({
		graphql: async () => {
			if (response instanceof Error) throw response;
			return Promise.resolve(response);
		},
	});
}

describe("getActionsBillingBlockHandler", () => {
	const refused = {
		data: {
			repository: {
				isPrivate: true,
				object: {
					checkSuites: {
						nodes: [
							{
								checkRuns: {
									nodes: [
										{
											annotations: {
												nodes: [
													{
														message:
															"The job was not started because your account is locked due to a billing issue.",
													},
												],
											},
										},
									],
								},
							},
						],
					},
				},
			},
		},
	};

	it("asks GitHub about the project's repo, and keeps the pull-request path when GitHub can't say", async () => {
		const outcomes: Record<string, boolean> = {};
		respond(refused);
		outcomes.refused = await getActionsBillingBlockHandler({project: "secret", sha: "a".repeat(40)});
		respond(new Error("GitHub API server error (502): bad gateway"));
		outcomes.requestError = await getActionsBillingBlockHandler({project: "secret", sha: "a".repeat(40)});
		expect(outcomes).toStrictEqual({refused: true, requestError: false});
	});
});
