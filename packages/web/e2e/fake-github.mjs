/**
 * A fake GitHub for the landing end-to-end harness: answers the GraphQL queries wip sends (viewer,
 * fork parent, repository id, open PRs with checks, auto-merge setting, visibility and the token's
 * permission, merged PRs, create PR) from in-memory state plus the refs of the harness's local bare
 * repos, and serves stand-in PR and new-PR (compare) pages so a browser tab sent to GitHub lands
 * somewhere local. A repo whose viewerPermission is READ refuses a PR from its own branch, like GitHub. Every request is recorded. It never talks to
 * the network.
 */
import {execFileSync} from "node:child_process";
import {createServer} from "node:http";

const VIEWER_LOGIN = "e2e-user";

/**
 * @typedef {{owner: string; name: string; bareDir: string; parent?: string; baseCheck?: "SUCCESS" | "FAILURE" | "PENDING"; viewerPermission?: "ADMIN" | "WRITE" | "READ"}} FakeRepo
 * @typedef {{number: number; repository: string; headRefName: string; baseRefName: string; title: string; draft: boolean; check: "SUCCESS" | "FAILURE" | "PENDING"; autoMerge: boolean; headOid?: string}} FakePr
 */

async function readJson(request) {
	const body = await readBody(request);
	return body === "" ? {} : JSON.parse(body);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			resolve(body);
		});
		request.on("error", reject);
	});
}

function commitOf(bareDir, ref) {
	try {
		const out = execFileSync("git", ["-C", bareDir, "log", "-1", "--format=%H%x1f%cI", ref], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const [oid = "", committedDate = ""] = out.split("\x1f");
		return oid === "" ? null : {oid, committedDate};
	} catch {
		return null;
	}
}

function rollup(state) {
	return {
		state,
		contexts: {
			nodes: [
				{
					__typename: "CheckRun",
					name: "build",
					conclusion: state === "SUCCESS" ? "SUCCESS" : state === "FAILURE" ? "FAILURE" : null,
					detailsUrl: null,
				},
			],
		},
	};
}

/**
 * Starts the fake on a free 127.0.0.1 port.
 * @param {{repos: FakeRepo[]; prs?: Array<Omit<FakePr, "autoMerge" | "draft" | "title"> & Partial<FakePr>>}} options
 */
export async function startFakeGitHub(options) {
	/** @type {Map<string, FakeRepo>} */
	const repos = new Map(options.repos.map((repo) => [`${repo.owner}/${repo.name}`, repo]));
	/** @type {FakePr[]} */
	const prs = (options.prs ?? []).map((pr) =>
		Object.assign({title: pr.headRefName, draft: false, autoMerge: false}, pr),
	);
	/** @type {Array<{query: string; variables: Record<string, unknown>; kind: string}>} */
	const graphqlCalls = [];
	let baseUrl = "";

	const prUrl = (pr) => `${baseUrl}/${pr.repository}/pull/${pr.number}`;

	function prNode(pr) {
		return {
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
			url: prUrl(pr),
			number: pr.number,
			author: {login: VIEWER_LOGIN},
			reviewDecision: null,
			mergeStateStatus: pr.check === "PENDING" ? "BLOCKED" : pr.check === "FAILURE" ? "BLOCKED" : "CLEAN",
			autoMergeRequest: pr.autoMerge ? {enabledAt: new Date().toISOString()} : null,
			reviewThreads: {nodes: []},
			commits: {nodes: [{commit: {statusCheckRollup: rollup(pr.check)}}]},
		};
	}

	function answer(query, variables) {
		const key = `${variables.owner}/${variables.name}`;
		const repo = repos.get(key);
		if (/\bviewer\s*\{\s*login/.test(query)) return {kind: "viewer", body: {data: {viewer: {login: VIEWER_LOGIN}}}};
		if (/\bsearch\(query:/.test(query)) return {kind: "search", body: {data: {search: {nodes: []}}}};
		if (/viewer\s*\{\s*projectsV2/.test(query)) {
			return {kind: "projects", body: {data: {viewer: {projectsV2: {nodes: []}}}}};
		}
		if (/mutation[\s\S]*createPullRequest/.test(query)) {
			const target = [...repos.values()].find((r) => `R_${r.owner}/${r.name}` === variables.repositoryId);
			if (target === undefined) {
				return {kind: "createPullRequest", body: {errors: [{message: "Could not resolve to a Repository"}]}};
			}
			const headRefName = String(variables.headRefName).replace(/^[^:]+:/, "");
			const repository = `${target.owner}/${target.name}`;
			if (target.viewerPermission === "READ" && !String(variables.headRefName).includes(":")) {
				return {kind: "createPullRequest", body: {data: null, errors: [{message: "must be a collaborator"}]}};
			}
			// The head as the PR was opened on it: the fork's branch for owner:branch, else the target's.
			const headOwner = /^([^:]+):/.exec(String(variables.headRefName))?.[1] ?? target.owner;
			const headRepo = repos.get(`${headOwner}/${target.name}`) ?? target;
			const headOid = commitOf(headRepo.bareDir, `refs/heads/${headRefName}`)?.oid;
			const pr = {
				number: prs.reduce((max, p) => (p.repository === repository ? Math.max(max, p.number) : max), 0) + 1,
				repository,
				headRefName,
				baseRefName: String(variables.baseRefName),
				title: String(variables.title),
				draft: variables.draft === true,
				check: "PENDING",
				autoMerge: false,
				...(headOid === undefined ? {} : {headOid}),
			};
			prs.push(pr);
			return {kind: "createPullRequest", body: {data: {createPullRequest: {pullRequest: {url: prUrl(pr)}}}}};
		}
		if (repo === undefined) {
			return {kind: "unknown-repo", body: {data: null, errors: [{message: `fake GitHub has no ${key}`}]}};
		}
		if (/parent\s*\{\s*owner/.test(query)) {
			const [owner, name] = (repo.parent ?? "").split("/");
			return {
				kind: "forkParent",
				body: {data: {repository: {parent: repo.parent ? {owner: {login: owner}, name} : null}}},
			};
		}
		if (/pullRequests\(first: 100, states: OPEN\)/.test(query)) {
			const qualified = String(variables.qualifiedBaseRef ?? "refs/heads/main");
			const target = commitOf(repo.bareDir, qualified);
			return {
				kind: "prStatuses",
				body: {
					data: {
						repository: {
							url: `${baseUrl}/${key}`,
							autoMergeAllowed: true,
							viewerPermission: repo.viewerPermission ?? "ADMIN",
							ref:
								target === null
									? null
									: {target: {...target, statusCheckRollup: rollup(repo.baseCheck ?? "SUCCESS")}},
							pullRequests: {nodes: prs.filter((pr) => pr.repository === key).map(prNode)},
						},
					},
				},
			};
		}
		if (/checkSuites\(/.test(query)) {
			return {kind: "checkSuites", body: {data: {repository: {object: {checkSuites: {nodes: []}}}}}};
		}
		if (/states: MERGED/.test(query)) {
			return {kind: "mergedPrs", body: {data: {repository: {pullRequests: {nodes: []}}}}};
		}
		if (/autoMergeAllowed/.test(query)) {
			return {kind: "autoMergeAllowed", body: {data: {repository: {autoMergeAllowed: true}}}};
		}
		if (/\bisPrivate\b/.test(query)) {
			return {
				kind: "repoFacts",
				body: {data: {repository: {isPrivate: false, viewerPermission: repo.viewerPermission ?? "ADMIN"}}},
			};
		}
		if (/\bviewerPermission\b/.test(query)) {
			return {
				kind: "viewerPermission",
				body: {data: {repository: {viewerPermission: repo.viewerPermission ?? "ADMIN"}}},
			};
		}
		if (/repository\(owner: \$owner, name: \$name\)\s*\{\s*id\s*\}/.test(query)) {
			return {kind: "repositoryId", body: {data: {repository: {id: `R_${key}`}}}};
		}
		return {kind: "unsupported", body: {data: null, errors: [{message: "fake GitHub: unsupported query"}]}};
	}

	const server = createServer((request, response) => {
		const handle = async () => {
			const url = new URL(request.url ?? "/", baseUrl);
			if (request.method === "POST" && url.pathname === "/graphql") {
				const {query = "", variables = {}} = await readJson(request);
				const {kind, body} = answer(String(query), variables);
				graphqlCalls.push({kind, query: String(query), variables});
				response.writeHead(200, {"Content-Type": "application/json"});
				response.end(JSON.stringify(body));
				return;
			}
			// The fake gh turns auto-merge on through here, like `gh pr merge --auto` does on GitHub.
			if (request.method === "POST" && url.pathname === "/fake/auto-merge") {
				const {repository, number} = await readJson(request);
				const pr = prs.find((p) => p.repository === repository && p.number === Number(number));
				if (pr !== undefined) pr.autoMerge = true;
				response.writeHead(pr === undefined ? 404 : 200, {"Content-Type": "application/json"});
				response.end(JSON.stringify({ok: pr !== undefined}));
				return;
			}
			const pull = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url.pathname);
			if (request.method === "GET" && pull !== null) {
				const pr = prs.find((p) => p.repository === pull[1] && p.number === Number(pull[2]));
				response.writeHead(pr === undefined ? 404 : 200, {"Content-Type": "text/html; charset=utf-8"});
				response.end(
					`<!doctype html><title>Fake PR</title><h1 data-testid="fake-pr">${pull[1]}#${pull[2]}</h1>`,
				);
				return;
			}
			// GitHub's prefilled new-PR page, where the user clicks Create in their own browser session.
			const compare = /^\/([^/]+\/[^/]+)\/compare\/(.+)$/.exec(url.pathname);
			if (request.method === "GET" && compare !== null) {
				response.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
				response.end(
					`<!doctype html><title>Fake new PR</title><h1 data-testid="fake-compare">${compare[1]} ${compare[2]}</h1>`,
				);
				return;
			}
			response.writeHead(404, {"Content-Type": "text/plain"});
			response.end("fake GitHub: not found");
		};
		handle().catch((error) => {
			response.writeHead(500, {"Content-Type": "text/plain"});
			response.end(String(error));
		});
	});

	await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve(undefined);
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("fake GitHub did not bind a port");
	baseUrl = `http://127.0.0.1:${address.port}`;

	return {
		url: baseUrl,
		graphqlUrl: `${baseUrl}/graphql`,
		prs,
		graphqlCalls,
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => {
				server.close(() => {
					resolve(undefined);
				});
			});
		},
	};
}
