import {tracedExeca, type ExecaResult} from "../services/traced-execa.js";
import type {LadderResult, LadderRungName} from "./ladder.js";

/**
 * Ladder rungs that never touch a checkout: fetch and replay. Server-only
 * (spawns subprocesses); do not import from client-reachable modules.
 */

export interface LadderRungProject {
	name: string;
	/** Absolute project directory, used as the recipe's cwd. */
	path: string;
	upstreamRemote: string;
	upstreamBranch: string;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}(?:\\[[0-9;]*m|\\(B)`, "g");

async function runRecipe(project: LadderRungProject, recipeArgs: string[]): Promise<ExecaResult> {
	return tracedExeca("just", ["--global-justfile", ...recipeArgs], {
		cwd: project.path,
		// The global justfile runs `tput` at load time, which fails when TERM is unset (servers, CI).
		env: {
			UPSTREAM_REMOTE: project.upstreamRemote,
			UPSTREAM_BRANCH: project.upstreamBranch,
			TERM: process.env["TERM"] ?? "xterm-256color",
		},
		extendEnv: true,
		reject: false,
	});
}

function errorResult(project: LadderRungProject, rung: LadderRungName, result: ExecaResult): LadderResult {
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
	return {
		project: project.name,
		rungs: [{rung, status: "stopped", detail}],
		stop: {stop: "error", branches: []},
	};
}

export async function runFetchRung(project: LadderRungProject): Promise<LadderResult> {
	const result = await runRecipe(project, ["fetch"]);
	if (result.exitCode !== 0) return errorResult(project, "fetch", result);
	return {
		project: project.name,
		rungs: [{rung: "fetch", status: "passed", detail: `fetched ${project.upstreamRemote}`}],
	};
}

/** Extracts branch names listed under "Failed to replay N branch(es):". */
function parseFailedReplayBranches(output: string): string[] {
	const lines = output.replace(ANSI_PATTERN, "").split("\n");
	const start = lines.findIndex((line) => line.includes("Failed to replay") && line.includes("branch(es)"));
	if (start === -1) return [];
	const branches: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const match = line.match(/^\s+-\s+(\S+)\s*$/);
		if (!match?.[1]) break;
		branches.push(match[1]);
	}
	return branches;
}

export async function runReplayRung(project: LadderRungProject): Promise<LadderResult> {
	const result = await runRecipe(project, ["replay-all", "true"]);
	const failed = parseFailedReplayBranches(result.stdout);
	if (failed.length > 0) {
		return {
			project: project.name,
			rungs: [{rung: "replay", status: "stopped", detail: `failed to replay ${failed.length} branch(es)`}],
			stop: {stop: "conflict", branches: failed},
		};
	}
	if (result.exitCode !== 0) return errorResult(project, "replay", result);
	return {project: project.name, rungs: [{rung: "replay", status: "passed", detail: "replayed"}]};
}
