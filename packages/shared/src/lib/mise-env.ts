import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {z} from "zod";

import {log} from "../services/logger-pino.js";
import {tracedExeca} from "../services/traced-execa.js";
import {cacheMiseEnv, getCachedMiseEnv} from "./db.js";

const MiseEnvSchema = z.record(z.string(), z.string());

// mise.toml, .mise.toml, mise.local.toml, mise.<env>.toml, .mise.<env>.local.toml, ...
const MISE_TOML = /^\.?mise(\.[\w.-]+)?\.toml$/;
// Config directories mise reads inside a project or any of its ancestors.
const CONFIG_DIRS = [".mise", "mise", ".config/mise", ".config/mise/conf.d", ".mise/conf.d", "mise/conf.d"];

function entries(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function stamp(file: string): string | null {
	try {
		const st = fs.statSync(file);
		return `${file}:${st.mtimeMs}:${st.size}`;
	} catch {
		return null;
	}
}

function ancestors(dir: string): string[] {
	const result: string[] = [];
	for (let d = path.resolve(dir); !result.includes(d); d = path.dirname(d)) result.push(d);
	return result;
}

function miseConfigDir(): string {
	return (
		process.env["MISE_CONFIG_DIR"] ??
		path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "mise")
	);
}

function miseInstallsDir(): string {
	const dataDir =
		process.env["MISE_DATA_DIR"] ??
		path.join(process.env["XDG_DATA_HOME"] ?? path.join(os.homedir(), ".local", "share"), "mise");
	return path.join(dataDir, "installs");
}

/**
 * A cheap stamp of everything `mise env` reads: the mise config files in `dir` and its ancestors,
 * the global and system config, and the installed tools. Any edit, new file or new install
 * changes it, so a cached env is reused only while it still matches what mise would print.
 */
export function miseConfigFingerprint(dir: string): string {
	const files: string[] = [];
	for (const a of ancestors(dir)) {
		for (const name of entries(a)) {
			if (MISE_TOML.test(name) || name === ".tool-versions") files.push(path.join(a, name));
		}
		files.push(path.join(a, ".config", "mise.toml"));
		for (const sub of CONFIG_DIRS) {
			const d = path.join(a, sub);
			for (const name of entries(d)) if (name.endsWith(".toml")) files.push(path.join(d, name));
		}
	}
	const configDir = miseConfigDir();
	for (const name of entries(configDir)) if (name.endsWith(".toml")) files.push(path.join(configDir, name));
	for (const name of entries(path.join(configDir, "conf.d"))) files.push(path.join(configDir, "conf.d", name));
	const globalFile = process.env["MISE_GLOBAL_CONFIG_FILE"];
	if (globalFile !== undefined) files.push(globalFile);
	files.push("/etc/mise/config.toml");
	const installs = miseInstallsDir();
	files.push(installs, ...entries(installs).map((tool) => path.join(installs, tool)));

	return [...new Set(files)]
		.map(stamp)
		.filter((s): s is string => s !== null)
		.join("\n");
}

/** `mise env` for `dir`, cached until its mise config or installed tools change. */
export async function getMiseEnv(dir: string): Promise<Record<string, string>> {
	const fingerprint = miseConfigFingerprint(dir);
	const cached = getCachedMiseEnv(dir, fingerprint);
	if (cached) return MiseEnvSchema.parse(cached);

	const start = performance.now();
	const result = await tracedExeca("mise", ["env", "-C", dir, "--json"], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "mise", args: ["env", "-C", dir, "--json"], duration},
		`mise env -C ${dir} --json (${duration}ms)`,
	);

	if (result.exitCode !== 0) return {};

	const env = MiseEnvSchema.parse(JSON.parse(result.stdout));
	cacheMiseEnv(dir, env, fingerprint);
	return env;
}
