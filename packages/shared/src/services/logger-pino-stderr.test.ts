import {Writable} from "node:stream";

import {describe, it, expect} from "vite-plus/test";

import {createStderrLog} from "./logger-pino-stderr.js";

function collector(): {stream: Writable; lines: () => unknown[]} {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			chunks.push(chunk.toString());
			callback();
		},
	});
	return {
		stream,
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as unknown),
	};
}

describe("createStderrLog", () => {
	it("builds without an installed pretty-printer, as in the production bundle", () => {
		expect(() => createStderrLog()).not.toThrow();
	});

	it("writes one JSON line per entry with its category, message and fields", () => {
		const {stream, lines} = collector();
		const log = createStderrLog(stream);

		log.subprocess.info({cmd: "git", args: ["push"], duration: 12}, "git push");
		log.general.warn("ready buffer paused");

		expect(
			lines().map((line) => {
				const {time, pid, hostname, ...rest} = line as Record<string, unknown>;
				return Object.assign(rest, {time: typeof time, pid: typeof pid, hostname: typeof hostname});
			}),
		).toEqual([
			{
				level: 30,
				category: "subprocess",
				cmd: "git",
				args: ["push"],
				duration: 12,
				msg: "git push",
				time: "string",
				pid: "number",
				hostname: "string",
			},
			{
				level: 40,
				category: "general",
				msg: "ready buffer paused",
				time: "string",
				pid: "number",
				hostname: "string",
			},
		]);
	});
});
