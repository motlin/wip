import type {JobHandle, WorkQueue} from "@wip/shared";

import type {EscapeHatchRecipe} from "./escape-hatch.js";
import type {ReadyBuffer} from "./ready-buffer.js";
import {repoResource} from "./repo-resource.js";

/**
 * The dashboard's bulk actions (lean plan step 37). The primary one tops up the ready buffer, which
 * enqueues at most target - ready - inFlight advance jobs; nothing here enqueues one job per WIP
 * item. The escape hatch runs one of the user's global just recipes once per project.
 */

/** Ask the buffer to pull toward its ready target; not running when another process owns it, or it is off. */
export async function topUpReadyBuffer(buffer: Pick<ReadyBuffer, "pull"> | null): Promise<{running: boolean}> {
	if (buffer === null) return {running: false};
	await buffer.pull();
	return {running: true};
}

export interface EscapeHatchProject {
	name: string;
	dir: string;
	upstreamRemote: string;
	upstreamBranch: string;
}

export interface JustRecipeRun {
	cwd: string;
	args: string[];
	env: {UPSTREAM_REMOTE: string; UPSTREAM_BRANCH: string};
}

export interface EscapeHatchDeps {
	projects: readonly EscapeHatchProject[];
	queue: Pick<WorkQueue, "enqueue">;
	/** The repo the dashboard runs from; recipes that check out branches leave it alone. */
	isDashboardRepo: (dir: string) => boolean;
	exec: (run: JustRecipeRun, signal: AbortSignal) => Promise<{exitCode: number; stdout: string; stderr: string}>;
	onError?: (project: string, message: string) => void;
}

/** These recipes check branches out in the project directory, which would disrupt the running server. */
const CHECKS_OUT: ReadonlySet<EscapeHatchRecipe> = new Set(["g", "rebase-all"]);

export function runEscapeHatch(recipe: EscapeHatchRecipe, deps: EscapeHatchDeps): JobHandle[] {
	return deps.projects
		.filter((p) => !(CHECKS_OUT.has(recipe) && deps.isDashboardRepo(p.dir)))
		.map((p) =>
			deps.queue.enqueue({
				coalesceKey: `escape-hatch:${recipe}:${p.name}`,
				kind: "escape-hatch",
				project: p.name,
				costClass: "build",
				resources: [repoResource(p.name)],
				run: async (signal) => {
					const result = await deps.exec(
						{
							cwd: p.dir,
							args: ["--global-justfile", recipe],
							env: {UPSTREAM_REMOTE: p.upstreamRemote, UPSTREAM_BRANCH: p.upstreamBranch},
						},
						signal,
					);
					if (result.exitCode === 0) return;
					const detail = result.stderr.trim() || result.stdout.trim();
					deps.onError?.(p.name, `just ${recipe} exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
				},
			}),
		);
}
