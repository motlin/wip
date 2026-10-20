import FetchAdapter from "@pollyjs/adapter-fetch";
import {Polly, type PollyConfig} from "@pollyjs/core";
import FSPersister from "@pollyjs/persister-fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";

// The pollyjs CJS builds export the class as module.exports, but their type
// declarations describe an ES default export; accept either shape at runtime.
Polly.register("default" in FetchAdapter ? FetchAdapter.default : FetchAdapter);
Polly.register("default" in FSPersister ? FSPersister.default : FSPersister);

const currentDir = dirname(fileURLToPath(import.meta.url));
const recordingsDir = resolve(currentDir, "..", "__recordings__");

const isRecordMode = process.env["POLLY_RECORD"] === "true";

interface RecordingEntry {
	request?: {headers?: Array<{name: string; value: string}>};
}

export function setupPolly(context: {name: string}): {
	polly: Polly;
	stop: () => Promise<void>;
} {
	const config: PollyConfig = {
		mode: isRecordMode ? "record" : "replay",
		adapters: ["fetch"],
		adapterOptions: {
			fetch: {context: globalThis},
		},
		persister: "fs",
		persisterOptions: {
			fs: {recordingsDir},
		},
		recordIfMissing: isRecordMode,
		recordFailedRequests: true,
		matchRequestsBy: {
			headers: {
				exclude: ["authorization", "user-agent"],
			},
		},
		logLevel: "warn",
	};

	const polly = new Polly(context.name, config);

	// Sanitize auth tokens from recordings before persisting
	polly.server.any().on("beforePersist", (_req, recording: RecordingEntry) => {
		for (const header of recording.request?.headers ?? []) {
			if (header.name.toLowerCase() === "authorization") {
				header.value = "bearer [REDACTED]";
			}
		}
	});

	return {
		polly,
		stop: async () => polly.stop(),
	};
}
