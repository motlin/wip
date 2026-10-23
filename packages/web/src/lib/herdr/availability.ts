import * as fs from "node:fs";
import {z} from "zod";
import {herdrRequest} from "./client.js";
import {resolveHerdrSocketPath} from "./socket-path.js";

export interface HerdrAvailability {
	available: boolean;
	socketPath: string;
	version?: string;
	protocol?: number;
	reason?: "no-socket" | "connect-failed" | "timeout" | "bad-response";
}

const pongSchema = z.object({type: z.literal("pong"), version: z.string(), protocol: z.number().int().min(0)});

const PROBE_TIMEOUT_MS = 1500;

function unavailable(socketPath: string, reason: NonNullable<HerdrAvailability["reason"]>): HerdrAvailability {
	return {available: false, socketPath, reason};
}

/** Probe a herdr API socket (the default one when omitted) with a ping. */
export async function probeHerdr(
	socketPath: string = resolveHerdrSocketPath(),
	timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<HerdrAvailability> {
	if (!socketPath || !fs.existsSync(socketPath)) return unavailable(socketPath, "no-socket");

	const response = await herdrRequest({id: "wip:ping", method: "ping", params: {}}, timeoutMs, socketPath);
	if (!response.ok) {
		if (response.code === "connect-failed") return unavailable(socketPath, "connect-failed");
		if (response.code === "timeout") return unavailable(socketPath, "timeout");
		return unavailable(socketPath, "bad-response");
	}

	const parsed = pongSchema.safeParse(response.value);
	if (!parsed.success) return unavailable(socketPath, "bad-response");
	const result = parsed.data;
	return {available: true, socketPath, version: result.version, protocol: result.protocol};
}
