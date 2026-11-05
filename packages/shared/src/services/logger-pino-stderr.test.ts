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

	it("scrubs tokens and URL credentials from the fields and message, like the in-memory log buffer", () => {
		const {stream, lines} = collector();
		const log = createStderrLog(stream);

		log.subprocess.error(
			{
				cmd: "git",
				args: [
					"push",
					"https://e2e-user:ghp_12345abcdefghijklmnopqrstuvwxyz0123@github.com/acme/gears.git",
					"-c",
					"http.extraHeader=Authorization: bearer github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
				],
				stderr: "fatal: could not read from https://someone:hunter2secret@example.com/repo.git (token ghp_abcdefghijklmnopqrstuvwxyz0123456789)",
			},
			"git push https://someone:hunter2secret@example.com/repo.git failed",
		);

		const [line] = lines() as Record<string, unknown>[];
		expect({args: line?.["args"], stderr: line?.["stderr"], msg: line?.["msg"]}).toEqual({
			args: [
				"push",
				"https://[REDACTED]@github.com/acme/gears.git",
				"-c",
				"http.extraHeader=Authorization: bearer [REDACTED]",
			],
			stderr: "fatal: could not read from https://[REDACTED]@example.com/repo.git (token [REDACTED])",
			msg: "git push https://[REDACTED]@example.com/repo.git failed",
		});
	});

	it("keeps a logged error's type, message and stack, scrubbed", () => {
		const {stream, lines} = collector();
		const log = createStderrLog(stream);
		const error = new Error("push to https://u:ghp_12345abcdefghijklmnopqrstuvwxyz0123@github.com/a/b failed");
		error.stack = "Error: boom\n    at https://u:secretpass@example.com/x";

		log.general.error({err: error}, "push failed");

		const [line] = lines() as Record<string, unknown>[];
		expect(line?.["err"]).toEqual({
			type: "Error",
			message: "push to https://[REDACTED]@github.com/a/b failed",
			stack: "Error: boom\n    at https://[REDACTED]@example.com/x",
		});
	});
});
