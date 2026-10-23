import {
	getAiRungTimeoutMs,
	runLadder,
	runReplayRung,
	runRebaseLeftoversRung,
	type LadderResult,
	type LadderRunProject,
	type LadderStopInfo,
	type WorkQueue,
} from "@wip/shared";
import {repoResource} from "../repo-resource.js";
import {workQueue} from "../shared-work-queue.js";
import type {HerdrResult} from "./client.js";
import {launchInHerdr, type HerdrLaunchRequest, type HerdrLaunchResult} from "./launch.js";
import {waitForHerdrAgent, type HerdrWaitOptions, type HerdrWaitResult} from "./watch.js";

/**
 * AI ladder rungs: hand a stopped ladder to an interactive claude session in a visible herdr tab,
 * holding a queue slot until the agent finishes. Server-only.
 */

export interface AiRungDeps {
	queue: WorkQueue;
	launch: (request: HerdrLaunchRequest) => Promise<HerdrResult<HerdrLaunchResult>>;
	wait: (paneId: string, options: HerdrWaitOptions) => Promise<HerdrWaitResult>;
	/** Re-runs the cheap ladder rungs (replay + rebase leftovers) after the agent finished. */
	rerun: (project: LadderRunProject, signal: AbortSignal) => Promise<LadderResult>;
	timeoutMs: number;
}

const noop = async (project: {name: string}): Promise<LadderResult> =>
	Promise.resolve({project: project.name, rungs: []});

async function defaultRerun(project: LadderRunProject, signal: AbortSignal): Promise<LadderResult> {
	return runLadder(project, {
		signal,
		runners: {
			fetch: noop,
			"worktree-prune": noop,
			"delete-merged-local": noop,
			replay: runReplayRung,
			"rebase-leftovers": runRebaseLeftoversRung,
		},
	});
}

function shellQuote(text: string): string {
	return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Resolve rebase conflicts with `claude "/git:conflicts"` in a herdr tab. Returns the new ladder
 * result, or "stuck" when the timeout fires, herdr cannot launch the tab, or a branch that
 * conflicted before still conflicts after the agent ran.
 */
export async function runAiConflictRung(
	project: LadderRunProject,
	stop: LadderStopInfo,
	overrides: Partial<AiRungDeps> = {},
): Promise<LadderResult | "stuck"> {
	const deps: AiRungDeps = {
		queue: workQueue,
		launch: launchInHerdr,
		wait: waitForHerdrAgent,
		rerun: defaultRerun,
		timeoutMs: getAiRungTimeoutMs(),
		...overrides,
	};

	let outcome: LadderResult | "stuck" = "stuck";
	const handle = deps.queue.enqueue({
		coalesceKey: `ai-rung:conflicts:${project.name}`,
		resources: [repoResource(project.name)],
		kind: "ai-conflicts",
		project: project.name,
		costClass: "ai",
		run: async (signal) => {
			const prompt = ["/git:conflicts", ...stop.branches].join(" ");
			const launched = await deps.launch({
				cwd: project.path,
				label: `wip:${project.name}:conflicts`,
				command: `claude ${shellQuote(prompt)}`,
				focus: false,
			});
			if (!launched.ok) return;
			const waited = await deps.wait(launched.value.paneId, {timeoutMs: deps.timeoutMs, signal});
			if (waited !== "done") return;
			const next = await deps.rerun(project, signal);
			const again = next.stop?.stop === "conflict" && next.stop.branches.some((b) => stop.branches.includes(b));
			outcome = again ? "stuck" : next;
		},
	});
	await handle.settled;
	return outcome;
}
