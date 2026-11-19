import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, describe, expect, it} from "vite-plus/test";

import {launchInHerdr} from "../src/lib/herdr/launch.js";
import {waitForHerdrAgent} from "../src/lib/herdr/watch.js";
import {startFakeHerdr} from "./fake-herdr.mjs";

describe("fake herdr", () =>
{
	let herdr;
	let dir;

	afterEach(async () =>
	{
		await herdr?.close();
		herdr = undefined;
		if (dir)
			fs.rmSync(
				dir,
				{
					recursive: true,
					force: true,
				},
			);
	});

	it("runs a launched tab's command in its cwd and reports the agent done to wip's waiter", async () =>
	{
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fake-herdr-")));
		herdr = await startFakeHerdr(
			{
				socketPath: path.join(dir, "herdr.sock"),
				env: process.env,
			},
		);

		const launched = await launchInHerdr(
			{
				cwd: dir,
				label: "wip:demo:test-fix:x",
				command: 'echo "ran here" > out.txt',
				focus: false,
			},
			herdr.socketPath,
		);
		expect(launched).toStrictEqual(
			{
				ok: true,
				value:
				{
					tabId: "tab-1",
					paneId: "pane-1",
				},
			},
		);
		const waited = await waitForHerdrAgent(
			"pane-1",
			{
				timeoutMs: 10_000,
				socketPath: herdr.socketPath,
			},
		);

		expect(
			{
				waited,
				out: fs.readFileSync(path.join(dir, "out.txt"), "utf8"),
				launches: herdr.launches,
			},
		).toStrictEqual(
			{
				waited: "done",
				out: "ran here\n",
				launches: [
					{
						cwd: dir,
						label: "wip:demo:test-fix:x",
						focus: false,
						command: 'echo "ran here" > out.txt',
						exitCode: 0,
					},
				],
			},
		);
	});
});
