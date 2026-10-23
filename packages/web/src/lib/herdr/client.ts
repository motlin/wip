import * as net from "node:net";
import {z} from "zod";

export type HerdrResult<T> = {ok: true; value: T} | {ok: false; code: string; message: string};

const MAXIMUM_REQUEST_BYTES = 1024 * 1024;

function failure(code: string, message: string): HerdrResult<never> {
	return {ok: false, code, message};
}

const envelopeSchema = z.object({
	result: z.unknown().optional(),
	error: z.object({code: z.string(), message: z.string()}).optional(),
});

function serializeRequest(request: {id: string; method: string; params?: object}): HerdrResult<string> {
	const line = `${JSON.stringify({...request, params: request.params ?? {}})}\n`;
	if (Buffer.byteLength(line) > MAXIMUM_REQUEST_BYTES) {
		return failure("request-too-large", "herdr requests cannot exceed 1 MiB");
	}
	return {ok: true, value: line};
}

function parseResponse(line: string): HerdrResult<unknown> {
	let message: unknown;
	try {
		message = JSON.parse(line);
	} catch {
		return failure("bad-response", "herdr returned invalid JSON");
	}
	const parsed = envelopeSchema.safeParse(message);
	if (parsed.success) {
		if (parsed.data.error) return failure(parsed.data.error.code, parsed.data.error.message);
		if (message !== null && typeof message === "object" && "result" in message) {
			return {ok: true, value: parsed.data.result};
		}
	}
	return failure("bad-response", "herdr returned an invalid response envelope");
}

/** Send one newline-delimited JSON request over a fresh herdr API connection. */
export async function herdrRequest(
	request: {id: string; method: string; params?: object},
	timeoutMs: number,
	socketPath: string,
): Promise<HerdrResult<unknown>> {
	const serialized = serializeRequest(request);
	if (!serialized.ok) return Promise.resolve(serialized);

	return new Promise((resolve) => {
		let buffer = "";
		let settled = false;
		const socket = net.createConnection(socketPath);
		socket.setEncoding("utf8");

		const finish = (result: HerdrResult<unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolve(result);
		};
		const timeout = setTimeout(() => {
			finish(failure("timeout", "herdr request timed out"));
		}, timeoutMs);

		socket.on("connect", () => socket.write(serialized.value));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index !== -1) finish(parseResponse(buffer.slice(0, index)));
		});
		socket.on("error", (error) => {
			finish(failure("connect-failed", error.message));
		});
		socket.on("close", () => {
			finish(failure("closed", "herdr closed without a response"));
		});
	});
}
