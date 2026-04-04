import { Polly, type PollyConfig } from "@pollyjs/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FetchAdapter = require("@pollyjs/adapter-fetch");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FSPersister = require("@pollyjs/persister-fs");

Polly.register(FetchAdapter);
Polly.register(FSPersister);

const currentDir = dirname(fileURLToPath(import.meta.url));
const recordingsDir = resolve(currentDir, "..", "__recordings__");

const isRecordMode = process.env["POLLY_RECORD"] === "true";

export function setupPolly(context: { name: string }): {
  polly: Polly;
  stop: () => Promise<void>;
} {
  const config: PollyConfig = {
    mode: isRecordMode ? "record" : "replay",
    adapters: ["fetch"],
    adapterOptions: {
      fetch: { context: globalThis },
    },
    persister: "fs",
    persisterOptions: {
      fs: { recordingsDir },
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
  polly.server.any().on("beforePersist", (_req, recording) => {
    const entry = recording as { request?: { headers?: Array<{ name: string; value: string }> } };
    if (entry.request?.headers) {
      entry.request.headers = entry.request.headers.map(
        (header: { name: string; value: string }) => {
          if (header.name.toLowerCase() === "authorization") {
            return { ...header, value: "bearer [REDACTED]" };
          }
          return header;
        },
      );
    }
  });

  return {
    polly,
    stop: () => polly.stop(),
  };
}
