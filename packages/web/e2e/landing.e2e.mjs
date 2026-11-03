/**
 * Landing end-to-end harness: clicks through Ready to land in headless Chromium against a real wip
 * server, so landing flows are tested by a script instead of by hand.
 *
 * It builds a throwaway world (landing-world.mjs), starts a fake GitHub (fake-github.mjs) and the
 * production server (serve.mjs, which needs `just build`) with the ready buffer on, then drives
 * /queue: Open PR on a ready row, Open PR on a row upstream moved past, Fast-forward main, and Push
 * main, asserting on the git refs in the bare "GitHub" repos, the fake GitHub's PRs, and the
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

/** The row's box in page coordinates (Playwright scrolling a button into view is not a layout shift). */
async function rowBox(row) {
	return row.evaluate((element) => {
		const box = element.getBoundingClientRect();
		return {x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height};
	});
}

/**
 * The row's box once it has not moved for a second, so a measurement around a click sees only what
 * the click does, not the previous action's rows still settling.
 */
async function stableRowBox(row) {
	let previous = await rowBox(row);
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop -- samples the layout until it settles
		await row.page().waitForTimeout(1000);
		// eslint-disable-next-line no-await-in-loop -- samples the layout until it settles
		const current = await rowBox(row);
		if (JSON.stringify(current) === JSON.stringify(previous)) return current;
		previous = current;
	}
	throw new Error("the row never stopped moving");
}

/**
 * The confirm and the outcome are overlays: opening them must not move or resize the row. A row
 * that already left Ready to land (its action finished) has nothing left to shift.
 */
async function assertNoLayoutShift(row, before, what) {
	if ((await row.count()) === 0) return;
	assert.deepEqual(await rowBox(row), before, `${what}: the row moved or resized`);
}

function readyRow(page, subject) {
	return page.getByTestId("ready-to-land-row").filter({hasText: subject});
}

/**
 * Clicks Open PR on the row and confirms. Returns the tab the confirm opened, once it reaches the PR
 * the fake GitHub opened, after checking the confirm and the running outcome never moved the row.
 */
async function openPr(page, subject, expectedPrUrl) {
	const row = readyRow(page, subject);
	const before = await stableRowBox(row);
	await row.getByRole("button", {name: "Open PR"}).click();
	await page.getByTestId("land-confirm").waitFor();
	await assertNoLayoutShift(row, before, `${subject}: opening the confirm`);
	const popupPromise = page.context().waitForEvent("page");
	await page.getByTestId("land-confirm").getByRole("button", {name: "Confirm"}).click();
	const tab = await popupPromise;
	const firstUrl = tab.url();
	await page.getByRole("dialog", {name: "Action result"}).waitFor();
	await assertNoLayoutShift(row, before, `${subject}: running Open PR`);
	// The tab's own poll and the opener both send it to the PR, so a navigation can abort another: poll the URL.
	const deadline = Date.now() + WAIT_MS;
	while (tab.url() !== expectedPrUrl) {
		assert.ok(Date.now() < deadline, `${subject}: the tab stayed at ${tab.url()}, never reaching ${expectedPrUrl}`);
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
	const {widgets, sprockets, gadgets, broken} = world.repos;
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
		const movedUpstream = sprockets.landUpstream("upstream.txt", "Land someone else's change");
		await openPr(page, "Add the behind feature", `${gh.url}/acme/sprockets/pull/1`);
		const pushedBehind = world.git(sprockets.forkBare, "rev-parse", "refs/heads/behind-feature");
		assert.notEqual(pushedBehind, world.shas.behindSha, "the behind branch was rebased before pushing");
		assert.equal(world.git(sprockets.forkBare, "rev-parse", `${pushedBehind}^`), movedUpstream);
		assert.equal(world.git(sprockets.clone, "rev-parse", "refs/heads/behind-feature"), pushedBehind);
		assert.match(world.git(sprockets.clone, "test", "results", pushedBehind), /^good /, "retested green");
		assert.equal(
			gh.prs.find((pr) => pr.repository === "acme/sprockets" && pr.number === 1)?.headRefName,
			"behind-feature",
		);

		step("Fast-forward main");
		const upstreamBefore = world.git(gadgets.upstreamBare, "rev-parse", "refs/heads/main");
		const ffRow = readyRow(page, "Add the fast-forward feature");
		const ffBefore = await stableRowBox(ffRow);
		await ffRow.getByRole("button", {name: "Fast-forward main"}).click();
		await page.getByTestId("land-confirm").getByRole("button", {name: "Confirm"}).click();
		await assertNoLayoutShift(ffRow, ffBefore, "Fast-forward main");
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
				["pr", "merge", "1", "--squash", "--delete-branch", "--auto", "-R", "acme/sprockets"],
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
