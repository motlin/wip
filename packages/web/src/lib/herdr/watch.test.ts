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

beforeEach(() =>
{
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-watch-"));
	sockets = [];
	received = [];
});

afterEach(async () =>
{
	for (const socket of sockets) socket.destroy();
	if (server)
		await new Promise((resolve) =>
		{
			server?.close(resolve);
		});
	server = undefined;
	fs.rmSync(
		dir,
		{
			recursive: true,
			force: true,
		},
	);
});

async function listen(socketPath: string, onLine: (line: string, socket: net.Socket) => void): Promise<void>
{
	server = net.createServer((socket) =>
	{
		sockets.push(socket);
		let buffer = "";
		socket.on("data", (chunk) =>
		{
			buffer += chunk.toString();
			const index = buffer.indexOf("\n");
			if (index !== -1)
			{
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				received.push(line);
				onLine(line, socket);
			}
		});
		socket.on("error", () => {});
	});
	return new Promise((resolve) =>
	{
		server?.listen(socketPath, resolve);
	});
}

/** Answers like real herdr: `events.subscribe` starts a subscription, `pane.get` reports `currentStatus`. */
function herdr(
	currentStatus: string,
	onSubscribed: (socket: net.Socket) => void = () =>
	{
	},
)
{
	return (line: string, socket: net.Socket): void =>
	{
		const request = JSON.parse(line);
		if (request.method === "pane.get")
		{
			socket.write(
				`${JSON.stringify(
					{
						id: request.id,
						result:
						{
							type: "pane_info",
							pane:
							{
								pane_id: request.params.pane_id,
								agent_status: currentStatus,
							},
						},
					},
				)}\n`,
			);
			return;
		}
		socket.write(
			`${JSON.stringify(
				{
					id: request.id,
					result:
					{
						type: "subscription_started",
					},
				},
			)}\n`,
		);
		onSubscribed(socket);
	};
}

const ack = herdr("working");

function statusEvent(paneId: string, status: string, event = "pane.agent_status_changed"): string
{
	return `${JSON.stringify(
		{
			event,
			data:
			{
				pane_id: paneId,
				workspace_id: "w1",
				agent_status: status,
			},
		},
	)}\n`;
}

const closed = async (socket: net.Socket) =>
	new Promise<void>((resolve) =>
	{
		if (socket.destroyed) resolve();
		else
			socket.once("close", () =>
			{
				resolve();
			});
	});

describe("waitForHerdrAgent", () =>
{
	it("resolves done when the pane agent finishes, ignoring other panes and working", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(
			socketPath,
			herdr("working", (socket) =>
			{
				socket.write(statusEvent("p9", "done"));
				socket.write(statusEvent("p1", "working"));
				socket.write(statusEvent("p1", "done"));
			}),
		);
		const result = await waitForHerdrAgent(
			"p1",
			{
				timeoutMs: 2000,
				socketPath,
			},
		);
		expect(result).toBe("done");
		expect(JSON.parse(received[0] ?? "")).toEqual(
			{
				id: expect.any(String),
				method: "events.subscribe",
				params:
				{
					subscriptions: [
						{
							type: "pane.agent_status_changed",
							pane_id: "p1",
						},
					],
				},
			},
		);
		await closed(sockets[0]!);
	});

	it("accepts the underscore event name of older herdr", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(
			socketPath,
			herdr("working", (socket) =>
			{
				socket.write(statusEvent("p1", "done", "pane_agent_status_changed"));
			}),
		);
		expect(
			await waitForHerdrAgent(
				"p1",
				{
					timeoutMs: 2000,
					socketPath,
				},
			),
		).toBe("done");
	});

	it("keeps waiting on an idle event before the agent has worked", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(
			socketPath,
			herdr("idle", (socket) =>
			{
				socket.write(statusEvent("p1", "idle"));
			}),
		);
		expect(
			await waitForHerdrAgent(
				"p1",
				{
					timeoutMs: 200,
					socketPath,
				},
			),
		).toBe("timeout");
	});

	it("resolves done on idle once the agent has worked", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(
			socketPath,
			herdr("idle", (socket) =>
			{
				socket.write(statusEvent("p1", "idle"));
				socket.write(statusEvent("p1", "working"));
				socket.write(statusEvent("p1", "idle"));
			}),
		);
		expect(
			await waitForHerdrAgent(
				"p1",
				{
					timeoutMs: 2000,
					socketPath,
				},
			),
		).toBe("done");
	});

	it("resolves done on a done event without any working event", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(
			socketPath,
			herdr("idle", (socket) =>
			{
				socket.write(statusEvent("p1", "idle"));
				socket.write(statusEvent("p1", "done"));
			}),
		);
		expect(
			await waitForHerdrAgent(
				"p1",
				{
					timeoutMs: 2000,
					socketPath,
				},
			),
		).toBe("done");
	});

	it("resolves done when the agent already finished before the subscription started", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, herdr("done"));
		const result = await waitForHerdrAgent(
			"p1",
			{
				timeoutMs: 2000,
				socketPath,
			},
		);
		expect(result).toBe("done");
		expect(received.map((line): unknown => JSON.parse(line))).toEqual([
			{
				id: expect.any(String),
				method: "events.subscribe",
				params:
				{
					subscriptions: [
						{
							type: "pane.agent_status_changed",
							pane_id: "p1",
						},
					],
				},
			},
			{
				id: expect.any(String),
				method: "pane.get",
				params:
				{
					pane_id: "p1",
				},
			},
		]);
	});

	it("keeps waiting when the pane is idle when the subscription starts", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, herdr("idle"));
		expect(
			await waitForHerdrAgent(
				"p1",
				{
					timeoutMs: 200,
					socketPath,
				},
			),
		).toBe("timeout");
		expect(received.map((line): unknown => JSON.parse(line))).toEqual([
			{
				id: expect.any(String),
				method: "events.subscribe",
				params:
				{
					subscriptions: [
						{
							type: "pane.agent_status_changed",
							pane_id: "p1",
						},
					],
				},
			},
			{
				id: expect.any(String),
				method: "pane.get",
				params:
				{
					pane_id: "p1",
				},
			},
		]);
	});

	it("resolves timeout and closes the connection", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const result = await waitForHerdrAgent(
			"p1",
			{
				timeoutMs: 50,
				socketPath,
			},
		);
		expect(result).toBe("timeout");
		await closed(sockets[0]!);
	});

	it("resolves aborted, closes the connection, and clears the timer", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const controller = new AbortController();
		const pending = waitForHerdrAgent(
			"p1",
			{
				timeoutMs: 60_000,
				signal: controller.signal,
				socketPath,
			},
		);
		setTimeout(() =>
		{
			controller.abort();
		}, 30);
		expect(await pending).toBe("aborted");
		await closed(sockets[0]!);
	});

	it("resolves aborted immediately for an already-aborted signal without connecting", async () =>
	{
		const socketPath = path.join(dir, "h.sock");
		await listen(socketPath, ack);
		const result = await waitForHerdrAgent(
			"p1",
			{
				timeoutMs: 1000,
				signal: AbortSignal.abort(),
				socketPath,
			},
		);
		expect(result).toBe("aborted");
		expect(sockets).toEqual([]);
	});
});
