import * as net from "node:net";
import {resolveHerdrSocketPath} from "./socket-path.js";

export type HerdrWaitResult = "done" | "timeout" | "aborted";

export interface HerdrWaitOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	socketPath?: string;
}

/**
 * Wait for the agent in `paneId` to finish, by subscribing to its status events on a dedicated
 * connection. Settling in any way clears the timer, the abort listener, and the socket.
 */
export async function waitForHerdrAgent(
	paneId: string,
	{timeoutMs, signal, socketPath = resolveHerdrSocketPath()}: HerdrWaitOptions,
): Promise<HerdrWaitResult> {
	if (signal?.aborted) return "aborted";

	return new Promise((resolve) => {
		let settled = false;
		let buffer = "";
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		const finish = (result: HerdrWaitResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners("data");
			socket.on("error", () => {});
			socket.destroy();
			resolve(result);
		};
		const onAbort = () => {
			finish("aborted");
		};
		const timer = setTimeout(() => {
			finish("timeout");
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, {once: true});

		const handleLine = (line: string) => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message === null || typeof message !== "object") return;
			const {event, data} = message as {event?: unknown; data?: Record<string, unknown> | null};
			if (event !== "pane_agent_status_changed" || !data) return;
			if (data["pane_id"] !== paneId) return;
			if (data["agent_status"] === "done" || data["agent_status"] === "idle") finish("done");
		};

		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					id: `wip:watch:${crypto.randomUUID().slice(0, 8)}`,
					method: "events.subscribe",
					params: {subscriptions: [{type: "pane.agent_status_changed", pane_id: paneId}]},
				})}\n`,
			);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				handleLine(buffer.slice(0, index));
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
			}
		});
		// A lost connection means completion can no longer be observed; treat it as a timeout-style failure.
		socket.on("error", () => {
			finish("timeout");
		});
		socket.on("close", () => {
			finish("timeout");
		});
	});
}
