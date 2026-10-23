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
import {tracedExeca} from "@wip/shared/services/traced-execa.js";
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
	/** Reads the stored `git test` results for a branch after the agent finished. */
	results: (project: LadderRunProject, branch: string) => Promise<"green" | "red">;
	timeoutMs: number;
	/** Called with the herdr tab and pane once the agent tab is launched. */
	onLaunched?: (launched: HerdrLaunchResult) => void;
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

/** Green only when at least one commit is listed and every line reports "good". */
export function parseGitTestResults(output: string): "green" | "red" {
	const lines = output.split("\n").filter((line) => line.trim() !== "");
	return lines.length > 0 && lines.every((line) => line.startsWith("good")) ? "green" : "red";
}

async function defaultResults(project: LadderRunProject, branch: string): Promise<"green" | "red"> {
	const range = `${project.upstreamRemote}/${project.upstreamBranch}..${branch}`;
	const result = await tracedExeca("git", ["-C", project.path, "test", "results", "--no-color", range], {
		reject: false,
	});
	return result.failed ? "red" : parseGitTestResults(result.stdout);
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
		results: defaultResults,
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
			deps.onLaunched?.(launched.value);
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

/**
 * Test and fix a branch with `claude "/build:test-branch"` in a herdr tab. Afterwards reads
 * `git test results` for the branch: "green" or "red", or "stuck" when the timeout fires or
 * herdr cannot launch the tab.
 */
export async function runAiTestFixRung(
	project: LadderRunProject,
	branch: string,
	overrides: Partial<AiRungDeps> = {},
): Promise<"green" | "red" | "stuck"> {
	const deps: AiRungDeps = {
		queue: workQueue,
		launch: launchInHerdr,
		wait: waitForHerdrAgent,
		rerun: defaultRerun,
		results: defaultResults,
		timeoutMs: getAiRungTimeoutMs(),
		...overrides,
	};

	let outcome: "green" | "red" | "stuck" = "stuck";
	const handle = deps.queue.enqueue({
		coalesceKey: `ai-rung:test-fix:${project.name}:${branch}`,
		resources: [repoResource(project.name)],
		kind: "ai-test-fix",
		project: project.name,
		costClass: "ai",
		run: async (signal) => {
			const launched = await deps.launch({
				cwd: project.path,
				label: `wip:${project.name}:test-fix:${branch}`,
				command: `claude ${shellQuote("/build:test-branch")}`,
				focus: false,
			});
			if (!launched.ok) return;
			const waited = await deps.wait(launched.value.paneId, {timeoutMs: deps.timeoutMs, signal});
			if (waited !== "done") return;
			outcome = await deps.results(project, branch);
		},
	});
	await handle.settled;
	return outcome;
}
