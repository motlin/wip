import {execFile} from "node:child_process";
import {existsSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import * as path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {afterEach, describe, expect, it} from "vite-plus/test";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(webDir, "dist", "server", "server.js");

// Loads the production SSR bundle the way serve.mjs does, with tracing on and
// an unreachable collector, then reports whether a tracer provider was
// registered globally and every "[wip] tracing" warning it printed.
const childScript = `
const warnings = [];
const warn = console.warn;
console.warn = (...args) => {
	const text = args.map(String).join(" ");
	if (text.includes("tracing failed to start")) warnings.push(text.split("\\n")[0]);
	else warn(...args);
};
await import(${JSON.stringify(pathToFileURL(serverEntry).href)});
const started = () => Boolean(globalThis[Symbol.for("opentelemetry.js.api.1")]?.trace);
for (let i = 0; i < 100 && !started() && warnings.length === 0; i++) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}
process.stdout.write(JSON.stringify({started: started(), warnings}));
process.exit(0);
`;

describe("tracing in the production build", () =>
{
	let tempDir: string | undefined;

	afterEach(() =>
	{
		if (tempDir !== undefined)
			rmSync(
				tempDir,
				{
					recursive: true,
					force: true,
				},
			);
		tempDir = undefined;
	});

	it("registers a tracer provider without failing to start", async () =>
	{
		if (!existsSync(serverEntry))
		{
			throw new Error(`No production build at ${serverEntry}; run \`just build\` first.`);
		}
		tempDir = mkdtempSync(path.join(tmpdir(), "wip-prod-tracing-"));
		const {stdout} = await promisify(execFile)(
			process.execPath,
			["--input-type=module", "-e", childScript],
			{
				cwd: webDir,
				env:
				{
					...process.env,
					HOME: tempDir,
					XDG_CONFIG_HOME: path.join(tempDir, "config"),
					XDG_DATA_HOME: path.join(tempDir, "data"),
					XDG_CACHE_HOME: path.join(tempDir, "cache"),
					XDG_STATE_HOME: path.join(tempDir, "state"),
					WIP_DB_PATH: path.join(tempDir, "wip.db"),
					WIP_READY_BUFFER: "false",
					WIP_TRACING: "true",
					OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:9/v1/traces",
				},
				timeout: 30_000,
			},
		);

		expect(JSON.parse(stdout)).toStrictEqual(
			{
				started: true,
				warnings: [],
			},
		);
	});
});
