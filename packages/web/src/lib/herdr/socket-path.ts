import * as path from "node:path";

/** herdr's release-build config directory: `$XDG_CONFIG_HOME/herdr`, else `~/.config/herdr`. */
function herdrConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const xdgConfigHome = env["XDG_CONFIG_HOME"];
	if (xdgConfigHome) return path.join(xdgConfigHome, "herdr");
	const home = env["HOME"];
	if (home) return path.join(home, ".config", "herdr");
	throw new Error("HOME must be set when XDG_CONFIG_HOME is unavailable");
}

/** The JSON API socket of herdr's named session. */
function herdrNamedSessionSocketPath(sessionName: string, env: NodeJS.ProcessEnv = process.env): string {
	return path.join(herdrConfigDirectory(env), "sessions", sessionName, "herdr.sock");
}

/** Resolve the JSON API socket (never `herdr-client.sock`, which speaks bincode). */
export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const explicitSocketPath = env["HERDR_SOCKET_PATH"];
	if (explicitSocketPath) return explicitSocketPath;

	const sessionName = env["HERDR_SESSION"];
	if (sessionName && sessionName !== "default") return herdrNamedSessionSocketPath(sessionName, env);

	return path.join(herdrConfigDirectory(env), "herdr.sock");
}
