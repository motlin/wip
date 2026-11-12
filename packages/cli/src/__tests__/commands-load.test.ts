import {describe, it, expect} from "vite-plus/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {fileURLToPath} from "node:url";
import {execa} from "execa";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const commandsDir = path.join(cliRoot, "src/commands");

// oclif's command ids: the path under src/commands with "/" as ":" and a trailing "index" dropped.
const commandIds = fs
	.readdirSync(commandsDir, {recursive: true, encoding: "utf8"})
	.filter((file) => file.endsWith(".ts"))
	.map((file) =>
		file
			.slice(0, -3)
			.split(path.sep)
			.filter((part, index, parts) => !(part === "index" && index === parts.length - 1))
			.join(":"),
	);

async function help(args: string[]): Promise<{command: string; exitCode: number | undefined; stderr: string}> {
	// Plain node, like the installed bin: it loads @wip/shared from source with Node's strip-only
	// type stripping, which rejects syntax vitest's transform accepts (e.g. parameter properties).
	const result = await execa("node", ["bin/run.js", ...args, "--help"], {cwd: cliRoot, reject: false});
	return {command: ["wip", ...args, "--help"].join(" "), exitCode: result.exitCode, stderr: result.stderr};
}

describe("wip bin", () => {
	it("loads every command under plain node: --help exits 0 with nothing on stderr", async () => {
		const results = await Promise.all([[], ...commandIds.map((id) => id.split(":"))].map(help));
		expect(results).toStrictEqual(results.map(({command}) => ({command, exitCode: 0, stderr: ""})));
	}, 60_000);
});
