import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";

import {getGitHubIdentity, resetGitHubIdentityForTests} from "./github-identity.js";
import {markGitHubRateLimited, resetGitHubRateLimit} from "./rate-limit.js";
import {createTestClient, resetGitHubClient, setGitHubClient} from "../services/github-client.js";
import {setupPolly} from "../test/setup-polly.js";

describe("getGitHubIdentity", () => {
	let pollyStop: (() => Promise<void>) | undefined;

	beforeEach(() => {
		setGitHubClient(createTestClient());
		resetGitHubRateLimit();
		resetGitHubIdentityForTests();
	});

	afterEach(async () => {
		if (pollyStop) {
			await pollyStop();
			pollyStop = undefined;
		}
		resetGitHubClient();
		resetGitHubRateLimit();
		resetGitHubIdentityForTests();
	});

	it("fetches the viewer's login and orgs once, then serves them from the cache", async () => {
		const {polly, stop} = setupPolly({name: "getGitHubIdentity-success"});
		pollyStop = stop;
		const queries: string[] = [];
		polly.server.post("https://api.github.com/graphql").intercept((req, res) => {
			queries.push((JSON.parse(req.body ?? "{}") as {query: string}).query);
			res.status(200).json({
				data: {
					viewer: {
						login: "motlin",
						organizations: {nodes: [{login: "liftwizard"}, {login: "eclipse-collections-kata"}]},
					},
				},
			});
		});

		const first = await getGitHubIdentity();
		const second = await getGitHubIdentity();

		expect({first, second, requests: queries.length}).toStrictEqual({
			first: {login: "motlin", orgs: ["liftwizard", "eclipse-collections-kata"]},
			second: {login: "motlin", orgs: ["liftwizard", "eclipse-collections-kata"]},
			requests: 1,
		});
	});

	it("returns null when the query fails, and does not retry during the cooldown", async () => {
		const {polly, stop} = setupPolly({name: "getGitHubIdentity-failure"});
		pollyStop = stop;
		let requests = 0;
		polly.server.post("https://api.github.com/graphql").intercept((_req, res) => {
			requests += 1;
			res.status(502).json({message: "Bad Gateway"});
		});

		expect({first: await getGitHubIdentity(), second: await getGitHubIdentity(), requests}).toStrictEqual({
			first: null,
			second: null,
			requests: 1,
		});
	});

	it("makes no request while GitHub is rate limited", async () => {
		let requested = false;
		setGitHubClient({
			async graphql(): Promise<unknown> {
				requested = true;
				return Promise.resolve({});
			},
		});
		markGitHubRateLimited();

		expect({identity: await getGitHubIdentity(), requested}).toStrictEqual({identity: null, requested: false});
	});
});
