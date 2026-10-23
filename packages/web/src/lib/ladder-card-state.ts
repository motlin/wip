import type {LadderResult, LadderStop} from "@wip/shared";

export interface LadderBranchState {
	stop?: LadderStop;
	aiStatus?: LadderResult["aiStatus"];
	needsAiCommand?: string;
	paneId?: string;
	testFix?: {status: "running" | "green" | "red" | "stuck"; attempts: number};
}

/**
 * Overlays the latest ladder result onto one branch: only branches named in a
 * stop (or carrying test/fix progress) get a state; every other branch is unchanged.
 */
export function ladderStateForBranch(
	results: readonly LadderResult[],
	project: string,
	branch: string,
): LadderBranchState | undefined {
	const result = results.find((r) => r.project === project);
	if (!result) return undefined;
	const testFix = result.testFix?.find((entry) => entry.branch === branch);
	const stop = result.stop?.branches.includes(branch) ? result.stop.stop : undefined;
	if (!stop && !testFix) return undefined;
	return {
		...(stop ? {stop} : {}),
		...(stop && result.aiStatus ? {aiStatus: result.aiStatus} : {}),
		...(stop && result.needsAi ? {needsAiCommand: result.needsAi.command} : {}),
		...(stop && result.herdr ? {paneId: result.herdr.paneId} : {}),
		...(testFix ? {testFix: {status: testFix.status, attempts: testFix.attempts}} : {}),
	};
}
