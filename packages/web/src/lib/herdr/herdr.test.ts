import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {probeHerdr} from "./availability.js";
import {herdrRequest} from "./client.js";
import {focusHerdrPane} from "./focus.js";
import {resolveHerdrSocketPath} from "./socket-path.js";

let dir: string;
let server: net.Server | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-test-"));
});

afterEach(async () => {
	if (server)
		await new Promise((resolve) => {
			server?.close(resolve);
		});
	server = undefined;
	fs.rmSync(dir, {recursive: true, force: true});
});

async function listen(socketPath: string, onLine: (line: string, socket: net.Socket) => void): Promise<void> {
	server = net.createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const index = buffer.indexOf("\n");
			if (index !== -1) onLine(buffer.slice(0, index), socket);
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) => {
		server?.listen(socketPath, resolve);
	});
}

describe("resolveHerdrSocketPath", () => {
	it("prefers HERDR_SOCKET_PATH", () => {
		expect(resolveHerdrSocketPath({HERDR_SOCKET_PATH: "/x/y.sock", HOME: "/h"})).toBe("/x/y.sock");
	});
	it("uses XDG_CONFIG_HOME, then HOME", () => {
		expect(resolveHerdrSocketPath({XDG_CONFIG_HOME: "/xdg"})).toBe("/xdg/herdr/herdr.sock");
		expect(resolveHerdrSocketPath({HOME: "/h"})).toBe("/h/.config/herdr/herdr.sock");
	});
	it("uses a named session", () => {
		expect(resolveHerdrSocketPath({HERDR_SESSION: "s", HOME: "/h"})).toBe("/h/.config/herdr/sessions/s/herdr.sock");
	});
});

describe("herdrRequest", () => {
	it("round-trips a request", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, (line, socket) => {
			const request = JSON.parse(line);
			socket.write(`${JSON.stringify({id: request.id, result: {echo: request.method}})}\n`);
		});
		expect(await herdrRequest({id: "1", method: "ping"}, 1000, socketPath)).toEqual({
			ok: true,
			value: {echo: "ping"},
		});
	});

	it("times out", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, () => {});
		const result = await herdrRequest({id: "1", method: "ping"}, 50, socketPath);
		expect(result).toEqual({ok: false, code: "timeout", message: "herdr request timed out"});
	});

	it("fails to connect", async () => {
		const result = await herdrRequest({id: "1", method: "ping"}, 500, path.join(dir, "none.sock"));
		expect(result.ok).toBe(false);
		expect(!result.ok && result.code).toBe("connect-failed");
	});
});

describe("probeHerdr", () => {
	it("is unavailable without a socket", async () => {
		const socketPath = path.join(dir, "none.sock");
		expect(await probeHerdr(socketPath)).toEqual({available: false, socketPath, reason: "no-socket"});
	});

	it("is available when herdr answers pong", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, (line, socket) => {
			socket.write(
				`${JSON.stringify({id: JSON.parse(line).id, result: {type: "pong", version: "1.2.3", protocol: 4}})}\n`,
			);
		});
		expect(await probeHerdr(socketPath)).toEqual({available: true, socketPath, version: "1.2.3", protocol: 4});
	});

	it("reports a bad response", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, (_line, socket) => {
			socket.write(`${JSON.stringify({id: "x", result: {type: "nope"}})}\n`);
		});
		expect(await probeHerdr(socketPath)).toEqual({available: false, socketPath, reason: "bad-response"});
	});

	it("reports a timeout", async () => {
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, () => {});
		expect(await probeHerdr(socketPath, 50)).toEqual({available: false, socketPath, reason: "timeout"});
	});
});

describe("focusHerdrPane", () => {
	it("sends pane.focus for the pane", async () => {
		const socketPath = path.join(dir, "h.sock");
		const requests: unknown[] = [];
		await listen(socketPath, (line, socket) => {
			const request = JSON.parse(line);
			requests.push({method: request.method, params: request.params});
			socket.write(`${JSON.stringify({id: request.id, result: {}})}\n`);
		});
		expect(await focusHerdrPane("pane-7", socketPath)).toEqual({ok: true, value: undefined});
		expect(requests).toEqual([{method: "pane.focus", params: {pane_id: "pane-7"}}]);
	});

	it("reports an unavailable herdr", async () => {
		const result = await focusHerdrPane("pane-7", path.join(dir, "none.sock"));
		expect(result.ok).toBe(false);
	});
});
