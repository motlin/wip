/**
 * Landing end-to-end harness: clicks through Ready to land in headless Chromium against a real wip
 * server, so landing flows are tested by a script instead of by hand.
 *
 * It builds a throwaway world (landing-world.mjs), starts a fake GitHub (fake-github.mjs) and the
 * production server (serve.mjs, which needs `just build`) with the ready buffer on, then drives
 * /queue: Open PR on a ready row, Open PR on a row upstream moved past in the same repo, Open PR where
 * the GitHub token is read-only on the PR repo (git pushes, the tab goes to GitHub's new-PR page),
 * Fast-forward main, Push main, the GitHub Actions gate (a queued check on one acme background push holds the next
 * acme push until it completes, not an other-org push), and a restart (with no page open, the restarted server must refresh cogs'
 * children when its upstream moves, read from the world DB) after which upstream moves past the one green row: it leaves
 * Ready to land and the buffer rebases and retests it until the ready target is met again, checking each Open PR leaves every repo's other rows on the page, and asserting on the git refs in the bare "GitHub" repos, the fake GitHub's PRs, and the
 * recorded gh calls. Before those, the auto-fix flow: bolts' commit fails its test, the buffer's test-fix agent
 * (the fake claude, launched through the fake herdr in fake-herdr.mjs) commits a separate fixup, the
 * card shows "auto-fixed: <failure>" and its review the fixup's diff, and Accept squashes it into one
 * green commit that lists in Ready to land. First of all, upstream red: /queue shows one upstream_red item,
 * for broken's own red upstream (its failed local baseline and /build:fix), broken's commits show blocked by
 * it and none lists in Ready to land, and levers' foreign red upstream gets no item and is a baseline: its
 * commit adding no failure lines up, its commit adding one does not, and the buffer pulled no commit in broken
 * (server.log's test runs) Private vaults' upstream check GitHub never started (billing) is no CI result: it gets
 * no item and its commit lines up by its local test.
 * The browser may only reach the wip server and the fake GitHub.
 *
 * Usage: just e2e-landing (or node packages/web/e2e/landing.e2e.mjs after `just build`).
 * WIP_E2E_KEEP=true keeps the temp world; it is always kept when a step fails.
 * WIP_E2E_HEADED=true shows the browser.
 * The server runs in its own process group, killed on every way out (pass, failure, timeout, signal),
 * and the run fails if any process is left holding the world's database.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {createServer} from "node:net";
import * as path from "node:path";
import {fileURLToPath} from "node:url";

import Database from "better-sqlite3";
import {chromium} from "playwright";

import {waitForChromiumCrashReports} from "./browser-crash.mjs";
import {startFakeGitHub} from "./fake-github.mjs";
import {startFakeHerdr} from "./fake-herdr.mjs";
import {createWorld, fsmonitorDaemonSockets} from "./landing-world.mjs";
import {processesHolding, startProcessTree, stopProcessTree} from "./server-process.mjs";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WAIT_MS = 180_000;
const keep = process.env.WIP_E2E_KEEP === "true";
/** How long rows must stay after an Open PR: past the children refresh that follows it. */
const ROWS_STAY_MS = 60_000;

let currentStep = "";
/** Logs the /queue page's JS heap and DOM size at each step, so a page that grows shows in the output. */
let sampleMemory = async () =>
{
};

function step(message)
{
	currentStep = message;
	console.log(`\n▸ ${message}`);
	void sampleMemory();
}

async function freePort()
{
	return new Promise((resolve, reject) =>
	{
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () =>
		{
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() =>
			{
				resolve(port);
			});
		});
	});
}

async function waitForServer(url, server)
{
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline)
	{
		if (server.exitCode !== null) throw new Error(`wip server exited with code ${server.exitCode}`);
		try
		{
			// eslint-disable-next-line no-await-in-loop -- polls until the server answers
			const response = await fetch(url);
			if (response.status < 500) return;
		}
		catch
		{
			// not listening yet
		}
		// eslint-disable-next-line no-await-in-loop -- polls until the server answers
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 250);
		});
	}
	throw new Error(`wip server did not answer at ${url}`);
}

/** Whether the world DB's current children cache for cogs lists a commit. Opens and closes the DB each call. */
function childrenListed(world, project, sha)
{
	const db = new Database(
		world.env.WIP_DB_PATH,
		{
			readonly: true,
			fileMustExist: true,
		},
	);
	try
	{
		const row = db
			.prepare("SELECT children_json FROM children_cache WHERE project = ? ORDER BY system_from DESC LIMIT 1")
			.get(project);
		return row !== undefined && row.children_json.includes(sha);
	}
	finally
	{
		db.close();
	}
}

/**
 * The shas `git test run` ran on, by repo, from server.log's subprocess lines: every test run happens in
 * the repo's sibling <repo>-test-worktree.
 */
function testRunsByRepo(serverLog)
{
	const byRepo = new Map();
	for (const line of fs.readFileSync(serverLog, "utf8").split("\n"))
	{
		if (!line.startsWith("{")) continue;
		let entry;
		try
		{
			entry = JSON.parse(line);
		}
		catch
		{
			continue;
		}
		const args = Array.isArray(entry.args) ? entry.args : [];
		const at = args.indexOf("test");
		const worktree = args[args.indexOf("-C") + 1];
		if (at === -1 || args[at + 1] !== "run" || typeof worktree !== "string") continue;
		const repo = /^(.+)-test-worktree$/.exec(path.basename(worktree))?.[1];
		if (repo === undefined) continue;
		const shas = byRepo.get(repo) ?? new Set();
		shas.add(args.at(-1));
		byRepo.set(repo, shas);
	}
	return byRepo;
}

/** server.log's "Ready-buffer push" entries for a project: each background push's outcome. */
function backgroundPushes(serverLog, project)
{
	return fs
		.readFileSync(serverLog, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.flatMap((line) =>
		{
			try
			{
				return [JSON.parse(line)];
			}
			catch
			{
				return [];
			}
		})
		.filter((entry) => entry.msg === "Ready-buffer push" && entry.project === project)
		.map(({branch, sha, push}) => (
		{
			branch,
			sha,
			push,
		}));
}

/** The sha a bare repo's branch points at, or "" when it has no such branch. */
function bareBranch(world, bareDir, branch)
{
	return world.git(bareDir, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
}

async function waitUntil(condition, what)
{
	const deadline = Date.now() + WAIT_MS;
	while (!condition())
	{
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		// eslint-disable-next-line no-await-in-loop -- polls until the condition holds
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 250);
		});
	}
}

const ROW_SELECTOR = ["ready-to-land-row", "waiting-row", "checks-failed-row"]
	.map((id) => `[data-testid="${id}"]`)
	.join(", ");

/**
 * Every Ready to land row as its kind and subject with its box in page coordinates (Playwright
 * scrolling a button into view is not a layout shift), in page order.
 */
async function rowBoxes(page)
{
	return page.locator(ROW_SELECTOR).evaluateAll((rows) =>
		rows.map((element) =>
		{
			const box = element.getBoundingClientRect();
			return {
				row: `${element.dataset.testid}: ${element.querySelector('a[href^="/item/"]')?.textContent ?? "?"}`,
				box:
				{
					x: box.x + window.scrollX,
					y: box.y + window.scrollY,
					width: box.width,
					height: box.height,
				},
			};
		}),
	);
}

/**
 * Every row's box once none has moved for a second, so a measurement around a click sees only what
 * the click does, not the previous action's rows still settling.
 */
async function stableRowBoxes(page)
{
	let previous = await rowBoxes(page);
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline)
	{
		// eslint-disable-next-line no-await-in-loop -- samples the layout until it settles
		await page.waitForTimeout(1000);
		// eslint-disable-next-line no-await-in-loop -- samples the layout until it settles
		const current = await rowBoxes(page);
		if (JSON.stringify(current) === JSON.stringify(previous)) return current;
		previous = current;
	}
	throw new Error("the Ready to land rows never stopped moving");
}

/**
 * The confirm and the outcome are overlays, and server updates never reorder rows: no Ready to land
 * row may move or resize. Rows keep their order; once the clicked row's own action changes it (it
 * leaves, or becomes a waiting row), only the rows above it must keep their boxes.
 */
async function assertNoLayoutShift(page, before, what)
{
	const after = await rowBoxes(page);
	const afterRows = new Set(after.map(({row}) => row));
	const beforeRows = new Set(before.map(({row}) => row));
	assert.deepEqual(
		after.map(({row}) => row).filter((row) => beforeRows.has(row)),
		before.map(({row}) => row).filter((row) => afterRows.has(row)),
		`${what}: the rows reordered`,
	);
	const firstChange = before.findIndex(({row}, i) => after[i]?.row !== row);
	const unchanged = firstChange === -1 ? before.length : firstChange;
	assert.deepEqual(after.slice(0, unchanged), before.slice(0, unchanged), `${what}: a row moved or resized`);
}

function readyRow(page, subject)
{
	return page.getByTestId("ready-to-land-row").filter(
		{
			hasText: subject,
		},
	);
}

/** The first of the rows ([testId or testIds, subject]) missing from the page, or undefined. */
async function missingRow(page, rows)
{
	for (const [testIds, subject] of rows)
	{
		const selector = [testIds]
			.flat()
			.map((id) => `[data-testid="${id}"]`)
			.join(", ");
		// eslint-disable-next-line no-await-in-loop -- checks every row in one sample
		if (
			(await page
				.locator(selector)
				.filter(
					{
						hasText: subject,
					},
				)
				.count()) === 0
		)
			return `${testIds} "${subject}"`;
	}
	return undefined;
}

/** The rows labelled only by a short sha: the client found no commit for them, so no subject. */
async function subjectlessRows(page)
{
	return (await rowBoxes(page)).map(({row}) => row).filter((row) => /: [0-9a-f]{7}$/.test(row));
}

/**
 * Samples the page for ROWS_STAY_MS and fails the moment any of the rows is missing or any row has
 * lost its subject: an action on one row must not drop the others, in its own repo or any other,
 * while the cache catches up.
 */
async function assertRowsStay(page, rows, what)
{
	const deadline = Date.now() + ROWS_STAY_MS;
	while (Date.now() < deadline)
	{
		// eslint-disable-next-line no-await-in-loop -- samples the page until the deadline
		const missing = await missingRow(page, rows);
		if (missing !== undefined)
		{
			// eslint-disable-next-line no-await-in-loop -- reads the rows once, on failure
			const shown = (await rowBoxes(page)).map(({row}) => row);
			assert.fail(`${what}: ${missing} left the page; the rows were ${JSON.stringify(shown)}`);
		}
		// eslint-disable-next-line no-await-in-loop -- samples the page until the deadline
		assert.deepEqual(await subjectlessRows(page), [], `${what}: rows without a subject`);
		// eslint-disable-next-line no-await-in-loop -- samples the page until the deadline
		await page.waitForTimeout(250);
	}
}

/**
 * Clicks Open PR on the row and confirms. Returns the tab the confirm opened, once it reaches the PR
 * the fake GitHub opened, after checking the confirm and the running outcome never moved a row and
 * the `stay` rows never left the page while it ran.
 */
async function openPr(page, subject, expectedPrUrl, stay = [], landingTestId = "fake-pr")
{
	const row = readyRow(page, subject);
	const before = await stableRowBoxes(page);
	await row
		.getByRole(
			"button",
			{
				name: "Open PR",
			},
		)
		.click();
	await page.getByTestId("land-confirm").waitFor();
	await assertNoLayoutShift(page, before, `${subject}: opening the confirm`);
	const popupPromise = page.context().waitForEvent("page");
	await page
		.getByTestId("land-confirm")
		.getByRole(
			"button",
			{
				name: "Confirm",
			},
		)
		.click();
	const tab = await popupPromise;
	const firstUrl = tab.url();
	await page
		.getByRole(
			"dialog",
			{
				name: "Action result",
			},
		)
		.waitFor();
	await assertNoLayoutShift(page, before, `${subject}: running Open PR`);
	// The tab's own poll and the opener both send it to the PR, so a navigation can abort another: poll the URL.
	const deadline = Date.now() + WAIT_MS;
	while (tab.url() !== expectedPrUrl)
	{
		assert.ok(Date.now() < deadline, `${subject}: the tab stayed at ${tab.url()}, never reaching ${expectedPrUrl}`);
		// eslint-disable-next-line no-await-in-loop -- samples the page while Open PR runs
		const missing = await missingRow(page, stay);
		assert.equal(missing, undefined, `${subject}: ${missing} left the page while Open PR ran`);
		// eslint-disable-next-line no-await-in-loop -- polls the tab's URL
		await tab.waitForTimeout(100);
	}
	await tab.getByTestId(landingTestId).waitFor();
	return {
		tab,
		firstUrl,
	};
}

async function run()
{
	step("Building the temp world");
	const world = createWorld();
	console.log(`  world: ${world.dirs.root}`);
	const {widgets, gadgets, broken, cogs, sprockets, gears, bolts, levers, vaults, pulleys, winches, cranks} =
		world.repos;
	const gh = await startFakeGitHub(
		{
			repos: world.fakeRepos,
			prs: [
				{
					number: 1,
					repository: "acme/widgets",
					headRefName: "waiting-feature",
					baseRefName: "main",
					check: "PENDING",
					autoMerge: true,
				},
			],
		},
	);
	// The ready buffer's test-fix agent launches here: the command runs with the world's fake claude.
	const herdr = await startFakeHerdr(
		{
			socketPath: world.env.HERDR_SOCKET_PATH,
			env: world.env,
		},
	);
	const port = await freePort();
	const baseUrl = `http://localhost:${port}`;
	const serverLog = path.join(world.dirs.root, "server.log");
	const logFd = fs.openSync(serverLog, "a");
	const startServer = () =>
		startProcessTree(
			process.execPath,
			["serve.mjs", "--port", String(port)],
			{
				cwd: webDir,
				env:
				{
					...world.env,
					WIP_GITHUB_GRAPHQL_URL: gh.graphqlUrl,
					WIP_GITHUB_WEB_URL: gh.url,
					WIP_E2E_FAKE_GITHUB: gh.url,
					// server.log gets the subprocess and general timeline as JSON lines.
					WIP_SUBPROCESS_LOGGING: "true",
				},
				stdio: ["ignore", logFd, logFd],
			},
		);
	let server = startServer();
	let browser;
	const blocked = [];
	const pageErrors = [];
	const crashes = [];
	const startedAt = Date.now();
	let ok = false;
	try
	{
		browser = await chromium.launch(
			{
				headless: process.env.WIP_E2E_HEADED !== "true",
				// The full Chromium build in new headless mode: chrome-headless-shell 156 segfaulted
				// (CrRendererMain, 0x5c0) in about one run in four; "chromium-headless-shell" brings it back.
				channel: process.env.WIP_E2E_CHANNEL || "chromium",
			},
		);
		step(`Starting wip on ${baseUrl} (ready buffer on) with fake GitHub at ${gh.url}`);
		await waitForServer(`${baseUrl}/`, server);

		const context = await browser.newContext(
			{
				viewport:
				{
					width: 1400,
					height: 1600,
				},
			},
		);
		// Only the wip server and the fake GitHub: anything else (fonts, GitHub, telemetry) is refused.
		const allowedOrigins = new Set([new URL(baseUrl).origin, gh.url, `http://127.0.0.1:${port}`]);
		await context.route("**/*", async (route) =>
		{
			const {origin} = new URL(route.request().url());
			if (allowedOrigins.has(origin)) return route.continue();
			blocked.push(route.request().url());
			return route.abort();
		});
		context.on("page", (page) =>
		{
			page.on("pageerror", (error) => pageErrors.push(String(error)));
			// Playwright only says "Target crashed" on the next call: record which page crashed, where and when.
			page.on("crash", () =>
			{
				crashes.push(
					{
						url: page.url(),
						step: currentStep,
						at: new Date().toISOString(),
					},
				);
				console.error(`\n✗ Chromium renderer crashed: ${page.url()} during "${currentStep}"`);
			});
		});
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		sampleMemory = async () =>
		{
			try
			{
				const {metrics} = await cdp.send("Performance.getMetrics");
				const metric = Object.fromEntries(metrics.map(({name, value}) => [name, value]));
				console.log(
					`  /queue page: JS heap ${(metric.JSHeapUsedSize / 1e6).toFixed(1)} MB, ${metric.Nodes} DOM nodes, ${metric.JSEventListeners} listeners`,
				);
			}
			catch
			{
				// the page crashed or closed; the crash listener reports it
			}
		};
		await page.goto(`${baseUrl}/queue`);

		step("Waiting for the ready buffer to test and ready every row");
		page.setDefaultTimeout(WAIT_MS);
		await readyRow(page, "Add the ready feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		await readyRow(page, "Add the behind feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		await readyRow(page, "Add the fast-forward feature")
			.getByRole(
				"button",
				{
					name: "Fast-forward main",
				},
			)
			.waitFor();
		await readyRow(page, "Add the steady feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		await readyRow(page, "Add the stale feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		await page
			.getByTestId("waiting-row")
			.filter(
				{
					hasText: "Add the waiting feature",
				},
			)
			.waitFor();
		await readyRow(page, "Add the gear feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		await page
			.getByTestId("ready-to-land-verify-notice")
			.filter(
				{
					hasText:
						"gears: your GitHub token has read-only access to acme/gears; grant it access to open PRs; testing locally",
				},
			)
			.waitFor();
		assert.match(
			await page
				.getByTestId("waiting-row")
				.filter(
					{
						hasText: "Add the waiting feature",
					},
				)
				.innerText(),
			/PR #1 · waiting for checks, merges itself when they pass/,
		);

		step("Upstream red: one queue item for broken, naming its failed baseline, and broken's commits show blocked");
		const redItem = page.getByTestId("upstream-red-item");
		await redItem
			.filter(
				{
					hasText: "broken",
				},
			)
			.waitFor();
		assert.deepEqual(
			{
				projects: await redItem.getByTestId("upstream-red-project").allInnerTexts(),
				failures: await redItem.getByTestId("upstream-red-failure").allInnerTexts(),
				actions: await redItem.getByRole("button").allInnerTexts(),
			},
			{
				projects: ["broken"],
				failures: ["local baseline test failed"],
				actions: ["/build:fix"],
			},
			"one upstream_red item, for broken alone: green and foreign red upstreams get none",
		);

		step(
			"A check GitHub never started (billing) is no CI result: vaults' upstream is not red and its commit lines up",
		);
		// wip read vaults' failed upstream check and asked GitHub whether that run ever started.
		await waitUntil(
			() =>
				gh.graphqlCalls.some(
					(call) =>
						call.kind === "checkRunStarts" &&
						Array.isArray(call.variables.ids) &&
						call.variables.ids.includes("CR_notstarted_acme/vaults"),
				),
			"wip asked whether vaults' failed upstream check run started",
		);
		await readyRow(page, "Add the vault feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		assert.deepEqual(
			{
				redProjects: await redItem.getByTestId("upstream-red-project").allInnerTexts(),
				blocked: await page
					.getByTestId(`branch-card-${world.shas.vaultSha}`)
					.getByTestId("upstream-red-blocked")
					.count(),
				tested: world.git(vaults.clone, "test", "results", world.shas.vaultSha).split(" ")[0],
			},
			{
				redProjects: ["broken"],
				blocked: 0,
				tested: "good",
			},
			"vaults gets no upstream_red item or Blocked marker, and its commit lines up by its local test",
		);
		// How long it has been red: the failing upstream commit's date, and its age once the client clock is read.
		await redItem
			.getByTestId("upstream-red-age")
			.filter(
				{
					hasText: /^red since \d{4}-\d{2}-\d{2} \(\d+d\)$/,
				},
			)
			.waitFor();
		for (const sha of [world.shas.fixSha, world.shas.blockedSha])
		{
			const card = page.locator(`[data-testid="branch-card-${sha}"], [data-testid="commit-card-${sha}"]`);
			// eslint-disable-next-line no-await-in-loop -- checks one card at a time
			await card.getByTestId("upstream-red-blocked").waitFor();
			assert.deepEqual(
				// eslint-disable-next-line no-await-in-loop -- checks one card at a time
				await card.getByTestId("upstream-red-blocked").allInnerTexts(),
				["Blocked: broken's upstream is red"],
				`broken's commit ${sha.slice(0, 7)} shows it is blocked by the upstream_red item`,
			);
		}
		assert.deepEqual(
			{
				fix: await readyRow(page, "Fix broken's tests").count(),
				blocked: await readyRow(page, "Add a feature on red upstream").count(),
			},
			{
				fix: 0,
				blocked: 0,
			},
			"a red upstream stops its repo's line: Ready to land lists nothing in it, not even a commit green on the red tip",
		);

		step("Remote only: a fork branch with no local branch and no PR is listed as lost work, never ready");
		const lostCard = page.getByTestId(`remote-only-card-${world.shas.lostSha}`);
		await lostCard.waitFor();
		assert.deepEqual(
			{
				state: await lostCard.getByTestId("remote-only-state").innerText(),
				actions: await lostCard.getByRole("button").allInnerTexts(),
				openPr: await lostCard
					.getByRole(
						"link",
						{
							name: "Open PR",
						},
					)
					.count(),
				ready: await readyRow(page, "Add the lost feature").count(),
			},
			{
				state: "Remote only: no local branch, no PR · origin/lost-feature",
				actions: ["Restore branch", "Delete remote branch"],
				openPr: 1,
				ready: 0,
			},
			"widgets' lost-feature shows Remote only with its restore, open PR and delete actions, and is not in Ready to land",
		);
		assert.deepEqual(
			{
				cards: await page.locator(`[data-testid$="-${world.shas.coveredSha}"]`).count(),
				ready: await readyRow(page, "Add the covered feature").count(),
				listed: childrenListed(world, "widgets", world.shas.coveredSha),
			},
			{
				cards: 0,
				ready: 0,
				listed: false,
			},
			"widgets' covered-feature, which PR #90's head ref covers, is the PR's: no remote-only row and no card",
		);

		step("Set up PR refs: vaults' PR remote fetches no refs/pull/*, so it has one item until the user clicks it");
		const prRefsItem = page.getByTestId("pr-refs-item");
		await prRefsItem
			.filter(
				{
					hasText: "vaults",
				},
			)
			.waitFor();
		assert.deepEqual(
			await prRefsItem.getByTestId("pr-refs-project").allInnerTexts(),
			["vaults"],
			"only vaults lacks the PR refspec",
		);
		assert.deepEqual(
			await page.evaluate(() =>
				[...document.querySelectorAll("main h2")]
					.map((heading) => heading.textContent ?? "")
					.filter((text) => /Set Up PR Refs|Upstream Red|Ready to land|Remote Only/.test(text))
					.map((text) => (text.match(/Set Up PR Refs|Upstream Red|Ready to land|Remote Only/) ?? [""])[0]),
			),
			["Set Up PR Refs", "Upstream Red", "Ready to land", "Remote Only"],
			"blockers rank above what they block: Set Up PR Refs, then Upstream Red, both above Ready to land",
		);
		await prRefsItem
			.filter(
				{
					hasText: "vaults",
				},
			)
			.getByRole(
				"button",
				{
					name: "Set up PR refs",
				},
			)
			.click();
		await waitUntil(
			() =>
				world
					.git(vaults.clone, "config", "--get-all", "remote.upstream.fetch")
					.includes("+refs/pull/*/head:refs/remotes/upstream/pr/*"),
			"Set up PR refs added the refspec to vaults' upstream",
		);
		await prRefsItem
			.filter(
				{
					hasText: "vaults",
				},
			)
			.waitFor(
				{
					state: "detached",
				},
			);

		step(
			"Foreign red upstream is the baseline: a commit adding no new failure lines up, one adding a failure does not",
		);
		const harmlessRow = readyRow(page, "Add a feature on foreign red upstream");
		await harmlessRow
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		assert.equal(
			await page.getByTestId(`branch-card-${world.shas.harmlessSha}`).getByTestId("upstream-red-blocked").count(),
			0,
			"a foreign red upstream blocks nothing: no blocked marker on its commit",
		);
		// The regressing commit fails a test upstream passes: its test fix is skipped (Claude doesn't trust levers),
		// which is how Ready to land learns it failed.
		await page
			.getByTestId("ready-to-land-verify-notice")
			.filter(
				{
					hasText: "levers: trust",
				},
			)
			.waitFor();
		assert.equal(
			await readyRow(page, "Add a new failure on foreign red upstream").count(),
			0,
			"a commit adding a failure to a foreign red upstream is not ready",
		);
		assert.match(
			world.git(levers.clone, "test", "results", world.shas.harmlessSha),
			/^bad /,
			"the harmless commit lines up although its own run failed: only the baseline's failure",
		);

		step("Auto-fix: bolts' commit fails its test, the agent commits a separate fixup, and Accept squashes it");
		const fragile = world.shas.fragileSha;
		const failure = "FAIL: fragile.txt breaks the bolts test";
		// A commit card: the branch tip is the fixup, so the failing commit is not its own branch.
		const fragileCard = page.getByTestId(`commit-card-${fragile}`);
		await fragileCard
			.getByTestId("auto-fixed-marker")
			.filter(
				{
					hasText: `auto-fixed: ${failure}`,
				},
			)
			.waitFor();
		const fixupSha = world.git(bolts.clone, "rev-parse", "refs/heads/fragile-feature");
		assert.equal(
			world.git(bolts.clone, "log", "-1", "--format=%P %s", fixupSha),
			`${fragile} fixup! Add the fragile feature`,
			"the fix is a separate fixup commit on the failing commit",
		);
		assert.deepEqual(
			herdr.launches.map(({label, focus, cwd, exitCode}) => (
			{
				label,
				focus,
				exitCode,
				cwd: path.dirname(cwd),
			})),
			[
				{
					label: "wip:bolts:test-fix:fragile-feature",
					focus: false,
					exitCode: 0,
					cwd: path.join(world.dirs.cache, "wip", "test-fix-worktrees", "bolts"),
				},
			],
			"one unfocused test-fix agent, in a throwaway worktree",
		);
		assert.equal(
			await readyRow(page, "Add the fragile feature").count(),
			0,
			"an unreviewed auto-fix is not ready to land",
		);
		await fragileCard
			.getByRole(
				"button",
				{
					name: "Review fix",
				},
			)
			.click();
		const review = fragileCard.getByTestId("auto-fix-review");
		await review
			.getByTestId("auto-fix-diff")
			.filter(
				{
					hasText: `-${failure}`,
				},
			)
			.waitFor();
		assert.match(await review.getByTestId("auto-fix-diff").innerText(), /deleted file mode 100644/);
		assert.match(await review.getByTestId("auto-fix-failure").innerText(), new RegExp(failure));
		const flowCounts = async () =>
		{
			const text = await page.getByTestId("flow-strip").innerText();
			const match = /\((\d+) commits .*· red (\d+)/.exec(text);
			assert.ok(match, `flow strip: ${text}`);
			return {
				commits: Number(match[1]),
				red: Number(match[2]),
			};
		};
		const beforeAccept = await flowCounts();
		await review
			.getByRole(
				"button",
				{
					name: "Accept fix",
				},
			)
			.click();
		const fragileRow = readyRow(page, "Add the fragile feature");
		await fragileRow
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		// The pre-squash commit is on no branch any more: its red card leaves at once, without a reload.
		await fragileCard.waitFor(
			{
				state: "detached",
				timeout: 3000,
			},
		);
		assert.deepEqual(
			await flowCounts(),
			{
				commits: beforeAccept.commits,
				red: beforeAccept.red - 1,
			},
			"Accept replaces the red commit with its green squash in the flow strip",
		);
		const squashed = world.git(bolts.clone, "rev-parse", "refs/heads/fragile-feature");
		const commitOf = (sha) => world.git(bolts.clone, "log", "-1", "--format=%P%n%an <%ae> %aI%n%B", sha);
		assert.deepEqual(
			{
				commits: world.git(bolts.clone, "rev-list", "upstream/main..fragile-feature"),
				commit: commitOf(squashed),
				tree: world.git(bolts.clone, "rev-parse", `${squashed}^{tree}`),
			},
			{
				commits: squashed,
				commit: commitOf(fragile),
				tree: world.git(bolts.clone, "rev-parse", `${fixupSha}^{tree}`),
			},
			"one commit: the original's parent, author and message with the fixup's tree",
		);
		assert.match(world.git(bolts.clone, "test", "results", squashed), /^good /, "the squashed commit is green");
		await fragileRow.locator(`a[href="/item/bolts/${squashed}"]`).waitFor();
		// It lands upstream before the other flows, so the restart's ready target of 1 still counts only sprockets.
		world.git(bolts.clone, "push", "--quiet", "upstream", `${squashed}:refs/heads/main`);
		world.git(bolts.clone, "fetch", "--quiet", "upstream");
		await fragileRow.waitFor(
			{
				state: "detached",
			},
		);

		step("Open PR on a ready row");
		const ready = await openPr(page, "Add the ready feature", `${gh.url}/acme/widgets/pull/2`);
		assert.match(
			ready.firstUrl,
			new RegExp(`^${baseUrl}/opening/[0-9a-f-]{36}$`),
			"the confirm opens /opening/<id>",
		);
		await ready.tab.close();
		await page
			.getByTestId("waiting-row")
			.filter(
				{
					hasText: "Add the ready feature",
				},
			)
			.filter(
				{
					hasText: "PR #2 · waiting for checks",
				},
			)
			.waitFor();
		await assertRowsStay(
			page,
			[
				["waiting-row", "Add the ready feature"],
				["ready-to-land-row", "Add the behind feature"],
				["waiting-row", "Add the waiting feature"],
				["ready-to-land-row", "Add the fast-forward feature"],
			],
			"after Open PR on widgets",
		);
		assert.equal(world.git(widgets.forkBare, "rev-parse", "refs/heads/ready-feature"), world.shas.readySha);
		assert.deepEqual(
			gh.prs.find((pr) => pr.repository === "acme/widgets" && pr.number === 2),
			{
				number: 2,
				repository: "acme/widgets",
				headRefName: "ready-feature",
				baseRefName: "main",
				title: "Add the ready feature",
				draft: false,
				check: "PENDING",
				autoMerge: true,
				headOid: world.shas.readySha,
			},
		);

		step("Open PR on a row whose upstream moved on (rebased and retested before pushing)");
		// The first Open PR's outcome sits above the behind row; dismiss it so the second click is measured alone.
		const firstOutcome = page.getByTestId("action-outcome").filter(
			{
				hasText: "Opened PR #2",
			},
		);
		await firstOutcome
			.getByRole(
				"button",
				{
					name: "Dismiss",
				},
			)
			.click();
		await firstOutcome.waitFor(
			{
				state: "detached",
			},
		);
		const movedUpstream = widgets.landUpstream("upstream.txt", "Land someone else's change");
		// Open PR invalidates widgets' children before its retest; the repo keeps its rows meanwhile.
		const behind = await openPr(page, "Add the behind feature", `${gh.url}/acme/widgets/pull/3`, [
			[["ready-to-land-row", "waiting-row"], "Add the behind feature"],
			["ready-to-land-row", "Add the fast-forward feature"],
		]);
		await behind.tab.close();
		const pushedBehind = world.git(widgets.forkBare, "rev-parse", "refs/heads/behind-feature");
		assert.notEqual(pushedBehind, world.shas.behindSha, "the behind branch was rebased before pushing");
		assert.equal(world.git(widgets.forkBare, "rev-parse", `${pushedBehind}^`), movedUpstream);
		assert.equal(world.git(widgets.clone, "rev-parse", "refs/heads/behind-feature"), pushedBehind);
		assert.match(world.git(widgets.clone, "test", "results", pushedBehind), /^good /, "retested green");
		assert.equal(
			gh.prs.find((pr) => pr.repository === "acme/widgets" && pr.number === 3)?.headRefName,
			"behind-feature",
		);
		await page
			.getByTestId("waiting-row")
			.filter(
				{
					hasText: "Add the behind feature",
				},
			)
			.filter(
				{
					hasText: "PR #3 · waiting for checks",
				},
			)
			.waitFor();
		// widgets' other rows legitimately change once upstream moves past them; the opened row and the
		// other repos' rows must not.
		await assertRowsStay(
			page,
			[
				["waiting-row", "Add the behind feature"],
				["ready-to-land-row", "Add the fast-forward feature"],
			],
			"after the second Open PR on widgets",
		);

		step("Fast-forward main");
		const upstreamBefore = world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main");
		const ffRow = readyRow(page, "Add the fast-forward feature");
		const ffBefore = await stableRowBoxes(page);
		await ffRow
			.getByRole(
				"button",
				{
					name: "Fast-forward main",
				},
			)
			.click();
		await page
			.getByTestId("land-confirm")
			.getByRole(
				"button",
				{
					name: "Confirm",
				},
			)
			.click();
		await assertNoLayoutShift(page, ffBefore, "Fast-forward main");
		await page
			.getByTestId("action-outcome")
			.filter(
				{
					hasText: "Moved local main to",
				},
			)
			.waitFor();
		assert.equal(world.git(gadgets.clone, "rev-parse", "refs/heads/main"), world.shas.ffSha);
		assert.equal(world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main"), upstreamBefore, "nothing pushed");

		step("Push main");
		const pushRow = page.getByTestId("push-row").filter(
			{
				hasText: "gadgets",
			},
		);
		await pushRow
			.getByRole(
				"button",
				{
					name: "Push 1 green commit to upstream/main",
				},
			)
			.click();
		await page
			.getByTestId("push-confirm")
			.getByRole(
				"button",
				{
					name: "Confirm",
				},
			)
			.click();
		await page
			.getByTestId("action-outcome")
			.filter(
				{
					hasText: "Pushed 1 green commit to upstream/main",
				},
			)
			.waitFor();
		assert.equal(world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main"), world.shas.ffSha);

		step("Open PR where the GitHub token is read-only: git pushes, then the tab goes to GitHub's new-PR page");
		const gearCompare = `${gh.url}/acme/gears/compare/main...gear-feature?quick_pull=1&title=Add+the+gear+feature`;
		const gear = await openPr(page, "Add the gear feature", gearCompare, [], "fake-compare");
		await gear.tab.close();
		const gearOutcome = page.getByTestId("action-outcome").filter(
			{
				hasText: "Pushed gear-feature; your GitHub token has read-only access to acme/gears",
			},
		);
		await gearOutcome.waitFor();
		assert.equal(world.git(gears.upstreamBare, "rev-parse", "refs/heads/gear-feature"), world.shas.gearSha);
		assert.deepEqual(
			gh.prs.filter((pr) => pr.repository === "acme/gears"),
			[],
			"no PR opened through the API, and no draft PR either",
		);
		assert.deepEqual(
			gh.graphqlCalls.filter(
				(call) => call.kind === "createPullRequest" && call.variables.repositoryId === "R_acme/gears",
			),
			[],
			"wip never asked the API to open a PR the token can't open",
		);
		await readyRow(page, "Add the gear feature")
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		// The outcome overlays the rows below it; dismiss it so the later clicks reach their rows.
		await gearOutcome
			.getByRole(
				"button",
				{
					name: "Dismiss",
				},
			)
			.click();
		await gearOutcome.waitFor(
			{
				state: "detached",
			},
		);

		step("GitHub Actions gate: a queued check on one acme push holds the next acme push, not other-org's");
		// Room for the three new commits whatever else is ready, so the buffer readies each one at once.
		world.setReadyTarget(20);
		const pulleySha = pulleys.branch("pulley-feature", "pulley.txt", "Add the pulley feature");
		gh.setCheckRuns("acme/pulleys", pulleySha, ["QUEUED"]);
		await waitUntil(
			() => bareBranch(world, pulleys.forkBare, "pulley-feature") === pulleySha,
			"the buffer force-pushed pulleys' ready commit to its fork",
		);
		const winchSha = winches.branch("winch-feature", "winch.txt", "Add the winch feature");
		const queuedReason = `GitHub Actions queued on acme/pulleys@${pulleySha}`;
		await waitUntil(
			() => backgroundPushes(serverLog, "winches").length > 0,
			"the buffer readied winches' commit and tried its background push",
		);
		assert.deepEqual(
			backgroundPushes(serverLog, "winches"),
			[
				{
					branch: "winch-feature",
					sha: winchSha,
					push:
					{
						status: "held",
						reason: queuedReason,
					},
				},
			],
			"winches' push waits on the queued check of the last acme push",
		);
		// GitHub's concurrent-job limit is per account: other-org's push is not held by acme's queued check.
		const crankSha = cranks.branch("crank-feature", "crank.txt", "Add the crank feature");
		await waitUntil(
			() => bareBranch(world, cranks.forkBare, "crank-feature") === crankSha,
			"the buffer force-pushed other-org's cranks commit while acme's check was queued",
		);
		assert.deepEqual(
			{
				cranks: backgroundPushes(serverLog, "cranks"),
				winches: bareBranch(world, winches.forkBare, "winch-feature"),
			},
			{
				cranks: [
					{
						branch: "crank-feature",
						sha: crankSha,
						push:
						{
							status: "pushed",
						},
					},
				],
				winches: "",
			},
			"cranks pushed at once, and winches' held push has not reached its fork",
		);
		// The check starts running: the held push goes on the pusher's next retry (children refresh or safety tick).
		gh.setCheckRuns("acme/pulleys", pulleySha, ["COMPLETED"]);
		await waitUntil(
			() => bareBranch(world, winches.forkBare, "winch-feature") === winchSha,
			"winches' held push reached its fork once acme's queued check completed",
		);
		// Out of the way before the restart, whose ready target of 1 counts only sprockets.
		for (const [r, branch] of [
			[pulleys, "pulley-feature"],
			[winches, "winch-feature"],
			[cranks, "crank-feature"],
		])
		{
			world.git(r.clone, "branch", "--quiet", "-D", branch);
			world.git(r.clone, "push", "--quiet", "origin", "--delete", branch);
		}

		step(
			"Restart, then upstream moves past a green row: it leaves Ready to land, and the buffer rebases and retests it",
		);
		await stopProcessTree(server);
		// vaults' green commit leaves while the server is down: its children cache still looks fresh, so the
		// restart must see vaults' refs changed and reread it, or it counts the gone commit as ready (target 1
		// met) and never re-advances sprockets. The buffer pushed it to its fork, and a commit only the fork
		// holds is no local work, so that branch goes too.
		world.git(vaults.clone, "branch", "--quiet", "-D", "vault-feature");
		if (world.git(vaults.clone, "ls-remote", "--heads", "origin", "vault-feature") !== "")
		{
			world.git(vaults.clone, "push", "--quiet", "origin", "--delete", "vault-feature");
		}
		assert.ok(
			childrenListed(world, "vaults", world.shas.vaultSha),
			"vaults' cached children still list the deleted vault-feature before the restart",
		);
		// levers' commits leave too, so the restart's ready target of 1 still counts only sprockets.
		world.git(levers.clone, "branch", "--quiet", "-D", "harmless-feature", "regressing-feature");
		// After the restart the buffer remembers nothing. sprockets is high priority, so its stale row is the
		// candidate the buffer advances first once it falls behind.
		world.setReadyTarget(1);
		world.setPriority("sprockets", "high");
		assert.ok(childrenListed(world, "cogs", world.shas.steadySha), "cogs' children list the steady commit");
		server = startServer();
		await waitForServer(`${baseUrl}/`, server);
		await waitUntil(
			() => !childrenListed(world, "vaults", world.shas.vaultSha),
			"the restarted server rereads vaults' fresh-looking children and drops the deleted vault-feature",
		);
		step(
			"With no page open, the restarted server watches repos: landing cogs' steady commit refreshes its children",
		);
		// cogs' steady commit and gears' gear commit land upstream, so sprockets' stale row alone is up to
		// date and green, meeting ready target 1. cogs lands before any page connects to /api/events.
		world.git(cogs.clone, "push", "--quiet", "upstream", `${world.shas.steadySha}:refs/heads/main`);
		world.git(cogs.clone, "fetch", "--quiet", "upstream");
		await waitUntil(
			() => !childrenListed(world, "cogs", world.shas.steadySha),
			"the background refresh drops cogs' landed steady commit from its children before a page connects",
		);
		await page.goto(`${baseUrl}/queue`);
		const staleRow = readyRow(page, "Add the stale feature");
		await staleRow
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		world.git(gears.clone, "push", "--quiet", "origin", `${world.shas.gearSha}:refs/heads/main`);
		world.git(gears.clone, "fetch", "--quiet", "origin");
		await readyRow(page, "Add the steady feature").waitFor(
			{
				state: "detached",
			},
		);
		await readyRow(page, "Add the gear feature").waitFor(
			{
				state: "detached",
			},
		);
		await staleRow
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		const movedPast = sprockets.landUpstream("other.txt", "Land someone else's sprockets change");
		world.git(sprockets.clone, "fetch", "--quiet", "upstream");
		// Behind upstream it is Needs Rebase, never ready: it leaves Ready to land, and the ready count drops
		// below the target, so the buffer rebases and retests it.
		await staleRow.waitFor(
			{
				state: "detached",
			},
		);
		await staleRow
			.getByRole(
				"button",
				{
					name: "Open PR",
				},
			)
			.waitFor();
		const advancedStale = world.git(sprockets.clone, "rev-parse", "refs/heads/stale-feature");
		assert.equal(world.git(sprockets.clone, "rev-parse", `${advancedStale}^`), movedPast, "the buffer rebased it");
		assert.match(world.git(sprockets.clone, "test", "results", advancedStale), /^good /, "and retested it green");
		// Listed at its up-to-date tip once the children refresh catches up with the replay.
		await staleRow.locator(`a[href="/item/sprockets/${advancedStale}"]`).waitFor();
		const stale = await openPr(page, "Add the stale feature", `${gh.url}/acme/sprockets/pull/1`, [
			[["ready-to-land-row", "waiting-row"], "Add the stale feature"],
		]);
		await stale.tab.close();
		assert.equal(
			gh.prs.find((pr) => pr.repository === "acme/sprockets" && pr.number === 1)?.headOid,
			advancedStale,
			"the PR opened on the tip the buffer rebased and retested",
		);
		await page
			.getByTestId("waiting-row")
			.filter(
				{
					hasText: "Add the stale feature",
				},
			)
			.filter(
				{
					hasText: "PR #1 · waiting for checks",
				},
			)
			.waitFor(
				{
					timeout: 30_000,
				},
			);
		await assertRowsStay(page, [["waiting-row", "Add the stale feature"]], "after Open PR on the re-advanced row");

		step("Checking what reached gh and GitHub");
		assert.deepEqual(
			world.ghCalls().filter((args) => args[0] !== "auth"),
			[
				["pr", "merge", "2", "--squash", "--delete-branch", "--auto", "-R", "acme/widgets"],
				["pr", "merge", "3", "--squash", "--delete-branch", "--auto", "-R", "acme/widgets"],
				["pr", "merge", "1", "--squash", "--delete-branch", "--auto", "-R", "acme/sprockets"],
			],
		);
		assert.equal(
			world.git(broken.upstreamBare, "rev-parse", "refs/heads/main"),
			world.git(broken.seed, "rev-parse", "HEAD"),
		);
		// Pulls stop for broken only: the buffer tested its upstream once to learn it is red, and none of its
		// commits, while every other repo's commits were tested.
		const testedByRepo = testRunsByRepo(serverLog);
		assert.deepEqual(
			[...(testedByRepo.get("broken") ?? [])],
			[world.git(broken.upstreamBare, "rev-parse", "refs/heads/main")],
			"the ready buffer pulled no commit in broken",
		);
		for (const name of ["widgets", "gadgets", "cogs", "sprockets", "bolts", "levers", "vaults"])
		{
			assert.ok((testedByRepo.get(name)?.size ?? 0) > 0, `the ready buffer tested ${name}'s commits`);
		}
		assert.deepEqual(blocked, [], "the browser asked for nothing outside wip and the fake GitHub");
		assert.deepEqual(pageErrors, [], "no uncaught errors in the page");
		await sampleMemory();
		ok = true;
		console.log("\n✓ landing flows passed");
	}
	finally
	{
		sampleMemory = async () =>
		{
		};
		const reports = await waitForChromiumCrashReports(
			startedAt,
			{
				crashSeen: crashes.length > 0,
			},
		);
		if (crashes.length > 0 || reports.length > 0)
		{
			console.error(`\nChromium crashes: ${JSON.stringify(crashes)}`);
			for (const report of reports)
			{
				console.error(
					`  ${report.process} pid ${report.pid} (${report.launched} → ${report.captured}): ${report.exception} on ${report.thread}; ${report.file}`,
				);
			}
		}
		await browser?.close();
		await stopProcessTree(server);
		await gh.close();
		await herdr.close();
		const dbPath = world.env.WIP_DB_PATH;
		const holders = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].flatMap((file) => processesHolding(file));
		if (holders.length > 0)
		{
			ok = false;
			process.exitCode = 1;
			console.error(
				`\n✗ processes still hold the world's database after the server stopped: ${holders.join(", ")}`,
			);
		}
		const fsmonitorSockets = fsmonitorDaemonSockets(world.dirs.root);
		if (fsmonitorSockets.length > 0)
		{
			ok = false;
			process.exitCode = 1;
			console.error(`\n✗ git fsmonitor daemons still watch repos in the world: ${fsmonitorSockets.join(", ")}`);
		}
		if (ok && !keep) world.remove();
		else console.log(`\nKept the world at ${world.dirs.root} (server log: ${serverLog})`);
	}
}

await run();
