import * as net from "node:net";
import {z} from "zod";
import {herdrRequest} from "./client.js";
import {resolveHerdrSocketPath} from "./socket-path.js";

/** Real herdr names the event `pane.agent_status_changed`; older herdr used underscores. */
const AGENT_STATUS_EVENTS = new Set(["pane.agent_status_changed", "pane_agent_status_changed"]);
const PANE_GET_TIMEOUT_MS = 10_000;
const paneInfoSchema = z.object({pane: z.object({agent_status: z.string()})});

/** The pane's current agent status from herdr's `pane.get` (on its own connection: a subscribed one answers nothing else). */
async function currentAgentStatus(paneId: string, socketPath: string): Promise<string | undefined> {
	const response = await herdrRequest(
		{id: `wip:pane-get:${crypto.randomUUID().slice(0, 8)}`, method: "pane.get", params: {pane_id: paneId}},
		PANE_GET_TIMEOUT_MS,
		socketPath,
	);
	if (!response.ok) return undefined;
	const parsed = paneInfoSchema.safeParse(response.value);
	return parsed.success ? parsed.data.pane.agent_status : undefined;
}

export type HerdrWaitResult = "done" | "timeout" | "aborted";

export interface HerdrWaitOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	socketPath?: string;
}

/**
 * Wait for the agent in `paneId` to finish, by subscribing to its status events on a dedicated
 * connection. Once the subscription starts it also asks for the pane's current status once, so an
 * agent that finished before the subscription existed still counts (only `done`: a freshly launched
 * claude can report idle before it starts the prompt). Settling in any way clears the timer, the
 * abort listener, and the socket.
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

		const subscribeId = `wip:watch:${crypto.randomUUID().slice(0, 8)}`;
		let checkedCurrentStatus = false;
		const checkCurrentStatus = async () => {
			if (checkedCurrentStatus) return;
			checkedCurrentStatus = true;
			if ((await currentAgentStatus(paneId, socketPath)) === "done") finish("done");
		};

		const handleLine = (line: string) => {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message === null || typeof message !== "object") return;
			const {id, event, data} = message as {id?: unknown; event?: unknown; data?: Record<string, unknown> | null};
			if (id === subscribeId) {
				void checkCurrentStatus();
				return;
			}
			if (typeof event !== "string" || !AGENT_STATUS_EVENTS.has(event) || !data) return;
			if (data["pane_id"] !== paneId) return;
			if (data["agent_status"] === "done" || data["agent_status"] === "idle") finish("done");
		};

		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({
					id: subscribeId,
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
