import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {describe, it, expect} from "vite-plus/test";

import {runProcess, type Task} from "./task-queue.js";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Waits up to 5s for `pid` to be gone. The group's SIGTERM and the grandchild's reaping are
 * asynchronous; under load a fixed short sleep can still see the grandchild, or its zombie.
 */
async function waitUntilGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		if (Date.now() > deadline) return false;
		// eslint-disable-next-line no-await-in-loop
		await sleep(20);
	}
}

describe("runProcess cancellation", () => {
	it("kills the whole process tree, so test runners a cancelled git test started do not outlive it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-task-kill-tree-"));
		const pidFile = path.join(dir, "grandchild.pid");
		// The child starts a grandchild (the sleep, standing in for just/vitest), records its pid, and waits on it.
		const script = `sleep 30 & echo $! > "${pidFile}"; wait`;
		const task: Task = {
			id: "kill-tree",
			taskType: "test",
			project: "wip",
			projectDir: dir,
			sha: "a".repeat(40),
			shortSha: "aaaaaaa",
			subject: "Kill tree",
			status: "running",
			queuedAt: 0,
		};
		const controller = new AbortController();
		const run = runProcess({
			task,
			cmd: "sh",
			args: ["-c", script],
			logDir: path.join(dir, "logs"),
			signal: controller.signal,
		});
		while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8").trim() === "") {
			// eslint-disable-next-line no-await-in-loop
			await sleep(20);
		}
		const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
		controller.abort();
		await run;
		const grandchildAlive = !(await waitUntilGone(grandchild));
		if (grandchildAlive) process.kill(grandchild, "SIGKILL");
		fs.rmSync(dir, {recursive: true, force: true});

		expect({grandchildAlive}).toStrictEqual({grandchildAlive: false});
	});
});
