import * as fs from "node:fs";
import * as path from "node:path";
import {Config, type Interfaces} from "@oclif/core";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * The CLI's oclif config without command discovery, for tests that run commands directly.
 *
 * Loading from the package root makes oclif import every `dist/commands` file through
 * Node's native loader to build a manifest. Those files reach `@wip/shared` as raw `src`
 * with `.js` specifiers, which only bin/run.js's resolve hook can load, so each import
 * fails with a MODULE_NOT_FOUND warning. A bare `Command.run(argv)` is worse: it loads
 * `@oclif/core` itself as the root and warns about its missing dev plugins. Tests never
 * look commands up by id, so the config leaves discovery out.
 */
export async function loadTestConfig(): Promise<Config> {
	const pjson: unknown = JSON.parse(fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8"));
	if (!isPjson(pjson)) throw new Error(`${CLI_ROOT}/package.json has no oclif section`);
	const {commands: _commands, ...oclif} = pjson.oclif;
	return await Config.load({root: CLI_ROOT, pjson: {...pjson, oclif}});
}

function isPjson(value: unknown): value is Interfaces.PJSON {
	return typeof value === "object" && value !== null && "oclif" in value;
}
