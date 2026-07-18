import {log} from "../services/logger-pino.js";
import {tracedExeca} from "../services/traced-execa.js";

/**
 * Lowest-level git helpers shared by the git plumbing layer and the GitHub
 * PR-status client. Lives below both so neither has to import the other.
 */

export async function git(dir: string, ...args: string[]): Promise<string> {
	const start = performance.now();
	const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "git", args: ["-C", dir, ...args], duration},
		`git -C ${dir} ${args.join(" ")} (${duration}ms)`,
	);
	if (result.exitCode !== 0) return "";
	return result.stdout.trim();
}

export function parseRemoteUrl(url: string): {owner: string; name: string} | undefined {
	const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match?.[1] || !match[2]) return undefined;
	return {owner: match[1], name: match[2]};
}
