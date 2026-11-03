/**
 * Landing end-to-end harness: clicks through Ready to land in headless Chromium against a real wip
 * server, so landing flows are tested by a script instead of by hand.
 *
 * It builds a throwaway world (landing-world.mjs), starts a fake GitHub (fake-github.mjs) and the
 * production server (serve.mjs, which needs `just build`) with the ready buffer on, then drives
 * /queue: Open PR on a ready row, Open PR on a row upstream moved past in the same repo, Fast-forward
 * main, and Push main, checking each Open PR leaves every repo's other rows on the page, and asserting on the git refs in the bare "GitHub" repos, the fake GitHub's PRs, and the
 * recorded gh calls. The browser may only reach the wip server and the fake GitHub.
 *
 * Usage: just e2e-landing (or node packages/web/e2e/landing.e2e.mjs after `just build`).
 * WIP_E2E_KEEP=true keeps the temp world; it is always kept when a step fails.
 * WIP_E2E_HEADED=true shows the browser.
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import * as fs from "node:fs";
import {createServer} from "node:net";
import * as path from "node:path";
import {fileURLToPath} from "node:url";

import {chromium} from "playwright";

import {startFakeGitHub} from "./fake-github.mjs";
import {createWorld} from "./landing-world.mjs";

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WAIT_MS = 180_000;
const keep = process.env.WIP_E2E_KEEP === "true";
/** How long rows must stay after an Open PR: past the children refresh that follows it. */
const ROWS_STAY_MS = 60_000;

function step(message) {
	console.log(`\n▸ ${message}`);
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => {
				resolve(port);
			});
		});
	});
}

async function waitForServer(url, server) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`wip server exited with code ${server.exitCode}`);
		try {
			// eslint-disable-next-line no-await-in-loop -- polls until the server answers
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch {
			// not listening yet
		}
		// eslint-disable-next-line no-await-in-loop -- polls until the server answers
		await new Promise((resolve) => {
			setTimeout(resolve, 250);
		});
	}
	throw new Error(`wip server did not answer at ${url}`);
}

const ROW_SELECTOR = ["ready-to-land-row", "waiting-row", "checks-failed-row"]
	.map((id) => `[data-testid="${id}"]`)
	.join(", ");

/**
 * Every Ready to land row as its kind and subject with its box in page coordinates (Playwright
 * scrolling a button into view is not a layout shift), in page order.
 */
async function rowBoxes(page) {
	return page.locator(ROW_SELECTOR).evaluateAll((rows) =>
		rows.map((element) => {
			const box = element.getBoundingClientRect();
			return {
				row: `${element.dataset.testid}: ${element.querySelector('a[href^="/item/"]')?.textContent ?? "?"}`,
				box: {x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height},
			};
		}),
	);
}

/**
 * Every row's box once none has moved for a second, so a measurement around a click sees only what
 * the click does, not the previous action's rows still settling.
 */
async function stableRowBoxes(page) {
	let previous = await rowBoxes(page);
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
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
async function assertNoLayoutShift(page, before, what) {
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

function readyRow(page, subject) {
	return page.getByTestId("ready-to-land-row").filter({hasText: subject});
}

/** The first of the rows ([testId or testIds, subject]) missing from the page, or undefined. */
async function missingRow(page, rows) {
	for (const [testIds, subject] of rows) {
		const selector = [testIds]
			.flat()
			.map((id) => `[data-testid="${id}"]`)
			.join(", ");
		// eslint-disable-next-line no-await-in-loop -- checks every row in one sample
		if ((await page.locator(selector).filter({hasText: subject}).count()) === 0) return `${testIds} "${subject}"`;
	}
	return undefined;
}

/**
 * Samples the page for ROWS_STAY_MS and fails the moment any of the rows is missing: an action on one
 * row must not drop the others, in its own repo or any other, while the cache catches up.
 */
async function assertRowsStay(page, rows, what) {
	const deadline = Date.now() + ROWS_STAY_MS;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop -- samples the page until the deadline
		const missing = await missingRow(page, rows);
		assert.equal(missing, undefined, `${what}: ${missing} left the page`);
		// eslint-disable-next-line no-await-in-loop -- samples the page until the deadline
		await page.waitForTimeout(250);
	}
}

/**
 * Clicks Open PR on the row and confirms. Returns the tab the confirm opened, once it reaches the PR
 * the fake GitHub opened, after checking the confirm and the running outcome never moved a row and
 * the `stay` rows never left the page while it ran.
 */
async function openPr(page, subject, expectedPrUrl, stay = []) {
	const row = readyRow(page, subject);
	const before = await stableRowBoxes(page);
	await row.getByRole("button", {name: "Open PR"}).click();
	await page.getByTestId("land-confirm").waitFor();
	await assertNoLayoutShift(page, before, `${subject}: opening the confirm`);
	const popupPromise = page.context().waitForEvent("page");
	await page.getByTestId("land-confirm").getByRole("button", {name: "Confirm"}).click();
	const tab = await popupPromise;
	const firstUrl = tab.url();
	await page.getByRole("dialog", {name: "Action result"}).waitFor();
	await assertNoLayoutShift(page, before, `${subject}: running Open PR`);
	// The tab's own poll and the opener both send it to the PR, so a navigation can abort another: poll the URL.
	const deadline = Date.now() + WAIT_MS;
	while (tab.url() !== expectedPrUrl) {
		assert.ok(Date.now() < deadline, `${subject}: the tab stayed at ${tab.url()}, never reaching ${expectedPrUrl}`);
		// eslint-disable-next-line no-await-in-loop -- samples the page while Open PR runs
		const missing = await missingRow(page, stay);
		assert.equal(missing, undefined, `${subject}: ${missing} left the page while Open PR ran`);
		// eslint-disable-next-line no-await-in-loop -- polls the tab's URL
		await tab.waitForTimeout(100);
	}
	await tab.getByTestId("fake-pr").waitFor();
	return {tab, firstUrl};
}

async function run() {
	step("Building the temp world");
	const world = createWorld();
	console.log(`  world: ${world.dirs.root}`);
	const {widgets, gadgets, broken} = world.repos;
	const gh = await startFakeGitHub({
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
	});
	const port = await freePort();
	const baseUrl = `http://localhost:${port}`;
	const serverLog = path.join(world.dirs.root, "server.log");
	const logFd = fs.openSync(serverLog, "a");
	const server = spawn(process.execPath, ["serve.mjs", "--port", String(port)], {
		cwd: webDir,
		env: {...world.env, WIP_GITHUB_GRAPHQL_URL: gh.graphqlUrl, WIP_E2E_FAKE_GITHUB: gh.url},
		stdio: ["ignore", logFd, logFd],
	});
	const browser = await chromium.launch({headless: process.env.WIP_E2E_HEADED !== "true"});
	const blocked = [];
	const pageErrors = [];
	let ok = false;
	try {
		step(`Starting wip on ${baseUrl} (ready buffer on) with fake GitHub at ${gh.url}`);
		await waitForServer(`${baseUrl}/`, server);

		const context = await browser.newContext({viewport: {width: 1400, height: 1600}});
		// Only the wip server and the fake GitHub: anything else (fonts, GitHub, telemetry) is refused.
		const allowedOrigins = new Set([new URL(baseUrl).origin, gh.url, `http://127.0.0.1:${port}`]);
		await context.route("**/*", async (route) => {
			const {origin} = new URL(route.request().url());
			if (allowedOrigins.has(origin)) return route.continue();
			blocked.push(route.request().url());
			return route.abort();
		});
		context.on("page", (page) => {
			page.on("pageerror", (error) => pageErrors.push(String(error)));
		});
		const page = await context.newPage();
		await page.goto(`${baseUrl}/queue`);

		step("Waiting for the ready buffer to test and ready every row");
		page.setDefaultTimeout(WAIT_MS);
		await readyRow(page, "Add the ready feature").getByRole("button", {name: "Open PR"}).waitFor();
		await readyRow(page, "Add the behind feature").getByRole("button", {name: "Open PR"}).waitFor();
		await readyRow(page, "Add the fast-forward feature").getByRole("button", {name: "Fast-forward main"}).waitFor();
		await readyRow(page, "Fix broken's tests").getByRole("button", {name: "Open PR"}).waitFor();
		await page.getByTestId("waiting-row").filter({hasText: "Add the waiting feature"}).waitFor();
		await page.getByTestId("upstream-red-marker").first().waitFor();
		assert.equal(
			await readyRow(page, "Add a feature on red upstream").count(),
			0,
			"a red commit on a red upstream is not ready",
		);
		assert.match(
			await page.getByTestId("waiting-row").filter({hasText: "Add the waiting feature"}).innerText(),
			/PR #1 · waiting for checks, merges itself when they pass/,
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
			.filter({hasText: "Add the ready feature"})
			.filter({hasText: "PR #2 · waiting for checks"})
			.waitFor();
		await assertRowsStay(
			page,
			[
				["waiting-row", "Add the ready feature"],
				["ready-to-land-row", "Add the behind feature"],
				["waiting-row", "Add the waiting feature"],
				["ready-to-land-row", "Add the fast-forward feature"],
				["ready-to-land-row", "Fix broken's tests"],
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
			},
		);

		step("Open PR on a row whose upstream moved on (rebased and retested before pushing)");
		// The first Open PR's outcome sits above the behind row; dismiss it so the second click is measured alone.
		const firstOutcome = page.getByTestId("action-outcome").filter({hasText: "Opened PR #2"});
		await firstOutcome.getByRole("button", {name: "Dismiss"}).click();
		await firstOutcome.waitFor({state: "detached"});
		const movedUpstream = widgets.landUpstream("upstream.txt", "Land someone else's change");
		// Open PR invalidates widgets' children before its retest; the repo keeps its rows meanwhile.
		const behind = await openPr(page, "Add the behind feature", `${gh.url}/acme/widgets/pull/3`, [
			[["ready-to-land-row", "waiting-row"], "Add the behind feature"],
			["ready-to-land-row", "Add the fast-forward feature"],
			["ready-to-land-row", "Fix broken's tests"],
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
			.filter({hasText: "Add the behind feature"})
			.filter({hasText: "PR #3 · waiting for checks"})
			.waitFor();
		// widgets' own rows legitimately change once upstream moves past them; the other repos' must not.
		await assertRowsStay(
			page,
			[
				["ready-to-land-row", "Add the fast-forward feature"],
				["ready-to-land-row", "Fix broken's tests"],
			],
			"after the second Open PR on widgets",
		);

		step("Fast-forward main");
		const upstreamBefore = world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main");
		const ffRow = readyRow(page, "Add the fast-forward feature");
		const ffBefore = await stableRowBoxes(page);
		await ffRow.getByRole("button", {name: "Fast-forward main"}).click();
		await page.getByTestId("land-confirm").getByRole("button", {name: "Confirm"}).click();
		await assertNoLayoutShift(page, ffBefore, "Fast-forward main");
		await page.getByTestId("action-outcome").filter({hasText: "Moved local main to"}).waitFor();
		assert.equal(world.git(gadgets.clone, "rev-parse", "refs/heads/main"), world.shas.ffSha);
		assert.equal(world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main"), upstreamBefore, "nothing pushed");

		step("Push main");
		const pushRow = page.getByTestId("push-row").filter({hasText: "gadgets"});
		await pushRow.getByRole("button", {name: "Push 1 green commit to upstream/main"}).click();
		await page.getByTestId("push-confirm").getByRole("button", {name: "Confirm"}).click();
		await page.getByTestId("action-outcome").filter({hasText: "Pushed 1 green commit to upstream/main"}).waitFor();
		assert.equal(world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main"), world.shas.ffSha);

		step("Checking what reached gh and GitHub");
		assert.deepEqual(
			world.ghCalls().filter((args) => args[0] !== "auth"),
			[
				["pr", "merge", "2", "--squash", "--delete-branch", "--auto", "-R", "acme/widgets"],
				["pr", "merge", "3", "--squash", "--delete-branch", "--auto", "-R", "acme/widgets"],
			],
		);
		assert.equal(
			world.git(broken.upstreamBare, "rev-parse", "refs/heads/main"),
			world.git(broken.seed, "rev-parse", "HEAD"),
		);
		assert.deepEqual(blocked, [], "the browser asked for nothing outside wip and the fake GitHub");
		assert.deepEqual(pageErrors, [], "no uncaught errors in the page");
		ok = true;
		console.log("\n✓ landing flows passed");
	} finally {
		await browser.close();
		server.kill("SIGTERM");
		await new Promise((resolve) => {
			if (server.exitCode !== null) resolve(undefined);
			else server.once("exit", resolve);
		});
		await gh.close();
		if (ok && !keep) world.remove();
		else console.log(`\nKept the world at ${world.dirs.root} (server log: ${serverLog})`);
	}
}

await run();
