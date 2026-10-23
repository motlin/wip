import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {launchInHerdr} from "./launch.js";

let dir: string;
let server: net.Server | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-launch-test-"));
});

afterEach(async () => {
	if (server)
		await new Promise((resolve) => {
			server?.close(resolve);
		});
	server = undefined;
	fs.rmSync(dir, {recursive: true, force: true});
});

async function listen(socketPath: string, seen: {method: string; params: unknown}[]): Promise<void> {
	server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const index = buffer.indexOf("\n");
			if (index === -1) return;
			const request = JSON.parse(buffer.slice(0, index));
			buffer = "";
			seen.push({method: request.method, params: request.params});
			const result =
				request.method === "tab.create"
					? {
							type: "tab_created",
							tab: {tab_id: "w1:t2"},
							root_pane: {pane_id: "w1:t2:p3"},
						}
					: {type: "ok"};
			socket.write(`${JSON.stringify({id: request.id, result})}\n`);
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) => {
		server?.listen(socketPath, resolve);
	});
}

describe("launchInHerdr", () => {
	it("creates a labelled unfocused tab in cwd and runs the command", async () => {
		const socketPath = path.join(dir, "h.sock");
		const seen: {method: string; params: unknown}[] = [];
		await listen(socketPath, seen);
		const result = await launchInHerdr(
			{cwd: "/tmp/proj", label: "rebase proj", command: "just build", focus: false},
			socketPath,
		);
		expect(result).toEqual({ok: true, value: {tabId: "w1:t2", paneId: "w1:t2:p3"}});
		expect(seen).toEqual([
			{method: "tab.create", params: {cwd: "/tmp/proj", label: "rebase proj", focus: false}},
			{method: "pane.send_text", params: {pane_id: "w1:t2:p3", text: "just build"}},
			{method: "pane.send_keys", params: {pane_id: "w1:t2:p3", keys: ["enter"]}},
		]);
	});

	it("returns a typed unavailable error when herdr is not running", async () => {
		const result = await launchInHerdr(
			{cwd: "/tmp/proj", label: "x", command: "true", focus: false},
			path.join(dir, "none.sock"),
		);
		expect(result).toEqual({ok: false, code: "unavailable", message: expect.any(String)});
	});
});
