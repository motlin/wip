import {tracedExeca} from "../services/traced-execa.js";

/**
 * Lowest-level git helpers shared by the git plumbing layer and the GitHub
 * PR-status client. Lives below both so neither has to import the other.
 */

export async function git(dir: string, ...args: string[]): Promise<string> {
	const result = await tracedExeca("git", ["-C", dir, ...args], {reject: false});
	if (result.exitCode !== 0) return "";
	return result.stdout.trim();
}

export function parseRemoteUrl(url: string): {owner: string; name: string} | undefined {
	const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
	if (!match?.[1] || !match[2]) return undefined;
	return {owner: match[1], name: match[2]};
}
