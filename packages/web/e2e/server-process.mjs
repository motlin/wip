/**
 * Process trees for the landing harness: the wip server it starts (and everything that server
 * starts: git test runs, claude, gh) must never outlive the harness. Each tree runs in its own
 * process group, killed as a group by stopProcessTree and, on every other way out of the harness
 * (uncaught error, process.exit, SIGINT/SIGTERM/SIGHUP), by an exit hook.
 */
import {spawn, spawnSync} from "node:child_process";
import * as fs from "node:fs";

/** Process group ids of trees that are still running. */
const liveGroups = new Set();
let hooksInstalled = false;

function killGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
	} catch {
		// the group is already gone
	}
}

function installExitHooks() {
	if (hooksInstalled) return;
	hooksInstalled = true;
	process.once("exit", () => {
		for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
	});
	for (const [signal, number] of [
		["SIGHUP", 1],
		["SIGINT", 2],
		["SIGTERM", 15],
	]) {
		process.once(signal, () => {
			process.exit(128 + number);
		});
	}
}

/** spawn() in a new process group that dies with the harness. */
export function startProcessTree(command, args, options) {
	installExitHooks();
	const child = spawn(command, args, {...options, detached: true});
	if (child.pid !== undefined) liveGroups.add(child.pid);
	return child;
}

function exited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM the tree's whole group, SIGKILL it if the leader is still up after 10s, and SIGKILL any stragglers. */
export async function stopProcessTree(child, graceMs = 10_000) {
	const pgid = child.pid;
	if (pgid === undefined) return;
	if (!exited(child)) {
		const done = new Promise((resolve) => {
			child.once("exit", resolve);
		});
		killGroup(pgid, "SIGTERM");
		let timer;
		const timedOut = new Promise((resolve) => {
			timer = setTimeout(() => {
				resolve("timeout");
			}, graceMs);
		});
		if ((await Promise.race([done, timedOut])) === "timeout") {
			killGroup(pgid, "SIGKILL");
			await done;
		}
		clearTimeout(timer);
	}
	killGroup(pgid, "SIGKILL");
	liveGroups.delete(pgid);
}

/** Pids of every process holding `file` open (lsof), or [] when the file is missing or nothing has it open. */
export function processesHolding(file) {
	if (!fs.existsSync(file)) return [];
	const result = spawnSync("lsof", ["-t", "--", file], {encoding: "utf8"});
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map(Number)
		.toSorted((a, b) => a - b);
}
