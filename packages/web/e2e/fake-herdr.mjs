/**
 * A fake herdr for the landing end-to-end harness: a JSON-lines server on a Unix socket (wip finds
 * it through HERDR_SOCKET_PATH) answering the calls wip's herdr client makes. `tab.create` opens a
 * tab, `pane.send_text` types a command and `pane.send_keys` ["enter"] runs it with `sh -c` in the
 * tab's cwd and the given env (so the world's fake claude answers); when it exits the pane's agent
 * reports "done" to every `events.subscribe` on it, in real herdr's envelope
 * (`pane.agent_status_changed`). Like real herdr it replays nothing to a later subscriber, which
 * sees the finished agent through `pane.get`.
 * Every launch is recorded. It never starts the real herdr or the real claude.
 */
import {spawn} from "node:child_process";
import * as fs from "node:fs";
import {createServer} from "node:net";

/**
 * @typedef {{cwd: string; label: string; focus: boolean; command?: string; exitCode?: number | null}} FakeLaunch
 */

function doneEvent(paneId) {
	return `${JSON.stringify({event: "pane.agent_status_changed", data: {pane_id: paneId, workspace_id: "w1", agent_status: "done"}})}\n`;
}

/** Records the command's exit and tells every subscriber to the pane that its agent is done. */
function finish(pane, paneId, exitCode) {
	pane.launch.exitCode = exitCode;
	pane.done = true;
	for (const socket of pane.subscribers) if (!socket.destroyed) socket.write(doneEvent(paneId));
}

/** @param {{socketPath: string; env: NodeJS.ProcessEnv}} options */
export async function startFakeHerdr({socketPath, env}) {
	/** @type {FakeLaunch[]} */
	const launches = [];
	/** pane id -> {launch, done, subscribers} */
	const panes = new Map();
	const children = new Set();
	const sockets = new Set();

	const handle = (socket, request) => {
		const reply = (result) => {
			socket.write(`${JSON.stringify({id: request.id, result})}\n`);
		};
		const params = request.params ?? {};
		switch (request.method) {
			case "tab.create": {
				const n = panes.size + 1;
				const launch = {cwd: params.cwd, label: params.label, focus: params.focus};
				launches.push(launch);
				panes.set(`pane-${n}`, {launch, done: false, subscribers: new Set()});
				reply({tab: {tab_id: `tab-${n}`}, root_pane: {pane_id: `pane-${n}`}});
				return;
			}
			case "pane.send_text": {
				const pane = panes.get(params.pane_id);
				if (pane) pane.launch.command = (pane.launch.command ?? "") + params.text;
				reply({});
				return;
			}
			case "pane.send_keys": {
				const pane = panes.get(params.pane_id);
				if (pane && pane.launch.command !== undefined && params.keys?.includes("enter")) {
					const child = spawn("sh", ["-c", pane.launch.command], {
						cwd: pane.launch.cwd,
						env,
						stdio: "ignore",
					});
					children.add(child);
					child.on("exit", (code) => {
						children.delete(child);
						finish(pane, params.pane_id, code);
					});
					child.on("error", () => {
						children.delete(child);
						finish(pane, params.pane_id, null);
					});
				}
				reply({});
				return;
			}
			case "events.subscribe": {
				reply({type: "subscription_started"});
				for (const subscription of params.subscriptions ?? []) {
					const pane = panes.get(subscription.pane_id);
					if (!pane) continue;
					pane.subscribers.add(socket);
					socket.on("close", () => pane.subscribers.delete(socket));
				}
				return;
			}
			case "pane.get": {
				const pane = panes.get(params.pane_id);
				if (!pane) {
					socket.write(
						`${JSON.stringify({id: request.id, error: {code: "pane_not_found", message: "no such pane"}})}\n`,
					);
					return;
				}
				reply({
					type: "pane_info",
					pane: {pane_id: params.pane_id, workspace_id: "w1", agent_status: pane.done ? "done" : "working"},
				});
				return;
			}
			default:
				reply({});
		}
	};

	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				try {
					handle(socket, JSON.parse(line));
				} catch {
					socket.write(`${JSON.stringify({error: {code: "bad-request", message: "invalid JSON"}})}\n`);
				}
				index = buffer.indexOf("\n");
			}
		});
	});
	fs.rmSync(socketPath, {force: true});
	await new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(socketPath, resolve);
	});

	return {
		socketPath,
		launches,
		async close() {
			for (const child of children) child.kill("SIGKILL");
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => {
				server.close(() => {
					resolve();
				});
			});
			fs.rmSync(socketPath, {force: true});
		},
	};
}
