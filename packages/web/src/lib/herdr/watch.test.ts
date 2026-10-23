import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {waitForHerdrAgent} from "./watch.js";

let dir: string;
let server: net.Server | undefined;
let sockets: net.Socket[];
let received: string[];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-watch-"));
	sockets = [];
	received = [];
});

afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	if (server)
		await new Promise((resolve) => {
			server?.close(resolve);
		});
	server = undefined;
	fs.rmSync(dir, {recursive: true, force: true});
});

async function listen(socketPath: string, onLine: (line: string, socket: net.Socket) => void): Promise<void> {
	server = net.createServer((socket) => {
		sockets.push(socket);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const index = buffer.indexOf("\n");
			if (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				received.push(line);
				onLine(line, socket);
			}
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) => {
		server?.listen(socketPath, resolve);
	});
}

function ack(line: string, socket: net.Socket): void {
	const request = JSON.parse(line);
	socket.write(`${JSON.stringify({id: request.id, result: {type: "subscription_started"}})}\n`);
}

function statusEvent(paneId: string, status: string): string {
	return `${JSON.stringify({event: "pane_agent_status_changed", data: {pane_id: paneId, agent_status: status}})}\n`;
}

const closed = async (socket: net.Socket) =>
	new Promise<void>((resolve) => {
		if (socket.destroyed) resolve();
		else
			socket.once("close", () => {
				resolve();
			});
	});

describe("waitForHerdrAgent", () => {
	it("resolves done when the pane agent finishes, ignoring other panes and working", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, (line, socket) => {
			ack(line, socket);
			socket.write(statusEvent("p9", "done"));
			socket.write(statusEvent("p1", "working"));
			socket.write(statusEvent("p1", "done"));
		});
		const result = await waitForHerdrAgent("p1", {timeoutMs: 2000, socketPath});
		expect(result).toBe("done");
		expect(JSON.parse(received[0] ?? "")).toEqual({
			id: expect.any(String),
			method: "events.subscribe",
			params: {subscriptions: [{type: "pane.agent_status_changed", pane_id: "p1"}]},
		});
		await closed(sockets[0]!);
	});

	it("resolves timeout and closes the connection", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const result = await waitForHerdrAgent("p1", {timeoutMs: 50, socketPath});
		expect(result).toBe("timeout");
		await closed(sockets[0]!);
	});

	it("resolves aborted, closes the connection, and clears the timer", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const controller = new AbortController();
		const pending = waitForHerdrAgent("p1", {timeoutMs: 60_000, signal: controller.signal, socketPath});
		setTimeout(() => {
			controller.abort();
		}, 30);
		expect(await pending).toBe("aborted");
		await closed(sockets[0]!);
	});

	it("resolves aborted immediately for an already-aborted signal without connecting", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const result = await waitForHerdrAgent("p1", {
			timeoutMs: 1000,
			signal: AbortSignal.abort(),
			socketPath,
		});
		expect(result).toBe("aborted");
		expect(sockets).toEqual([]);
	});
});
