import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {landingOrder, type ReadyToLandItem, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
import {wipAgeText} from "../lib/staleness";

const MARKER_CLASS =
	"inline-flex items-center rounded border border-border-300/50 px-1.5 py-0.5 text-[10px] font-medium text-text-400";

/**
 * The row's next step: in a pull-request repo, merge its PR, or open one when it has none yet (a
 * PR the user clicks to open is user-initiated); fast-forward otherwise. Null only when a
 * pull-request repo's commit has no branch to open a PR from.
 */
export type LandingAction =
	| {kind: "merge-pr"; label: string; prNumber: number}
	| {kind: "open-pr"; label: string; branch: string}
	| {kind: "fast-forward"; label: string};

export function landingAction(item: ReadyToLandItem, commit: GitChildResult | undefined): LandingAction | null {
	if (item.landing !== "pull-request") return {kind: "fast-forward", label: "Fast-forward"};
	if (commit?.prNumber !== undefined) {
		return {kind: "merge-pr", label: `Merge PR #${commit.prNumber}`, prNumber: commit.prNumber};
	}
	const branch = item.branch ?? commit?.branch;
	return branch === undefined ? null : {kind: "open-pr", label: "Open PR", branch};
}

/**
 * A stopped project (own upstream red) lands nothing but the fix: a commit that sits on the red
 * upstream tip and tests green, so landing it makes upstream green. Null when the row may land.
 */
function stoppedLineReason(
	project: string,
	stopped: ReadonlySet<string>,
	commit: GitChildResult | undefined,
): string | null {
	if (!stopped.has(project)) return null;
	const fixesUpstream = commit?.testStatus === "passed" && commit.commitsBehind === 0 && commit.needsRebase !== true;
	return fixesUpstream ? null : `${project}'s upstream is red: only the commit that makes it green can land`;
}

function sizeText(commit: GitChildResult | undefined): string | null {
	if (commit?.insertions === undefined && commit?.deletions === undefined) return null;
	const files = commit.files ?? 0;
	return `+${commit.insertions ?? 0} −${commit.deletions ?? 0} · ${files} ${files === 1 ? "file" : "files"}`;
}

export interface ReadyToLandSectionProps {
	state: ReadyToLandState | null | undefined;
	/** The cached children, joined by project and sha for subject, size and markers. */
	commits: readonly GitChildResult[];
	projects: readonly ProjectInfo[];
	/** Client clock for ages; null during SSR, which omits them. */
	now: number | null;
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
}

/**
 * Lean plan step 42: the ready buffer's ready commits, pinned first on /queue, in landing order
 * (stack prefixes first) with size, age ("in wip Nd" from first seen), markers and the landing action.
 */
export function ReadyToLandSection({state, commits, projects, now, onLand}: ReadyToLandSectionProps) {
	if (!state || (state.ready.length === 0 && state.inFlight.length === 0)) return null;
	const byKey = new Map(commits.map((c) => [`${c.project}:${c.sha}`, c]));
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	const stopped = new Set(state.stoppedProjects);

	return (
		<section className="mb-6 rounded-lg border border-status-green/40 bg-bg-100 p-4">
			<h2 data-testid="ready-to-land-heading" className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
				<span>Ready to land</span>
				<span className="text-xs font-normal tabular-nums text-text-500">
					{state.ready.length} ready (target {state.slots}) · {state.inFlight.length} readying
				</span>
			</h2>
			<ul className="flex flex-col gap-1.5">
				{landingOrder(state.ready).map((item) => {
					const commit = byKey.get(`${item.project}:${item.sha}`);
					const size = sizeText(commit);
					const action = landingAction(item, commit);
					const blockedReason = stoppedLineReason(item.project, stopped, commit);
					const noTests = projectMap.get(item.project)?.hasTestConfigured === false;
					const age = now === null || item.firstSeen === undefined ? null : wipAgeText(item.firstSeen, now);
					return (
						<li
							key={`${item.project}:${item.id}`}
							data-testid="ready-to-land-row"
							className="flex flex-wrap items-center gap-2 text-[0.8125rem]"
						>
							<span className="font-medium text-text-000">{commit?.subject ?? item.sha.slice(0, 7)}</span>
							<span className="text-xs text-text-500">{item.project}</span>
							{size !== null && <span className="text-xs tabular-nums text-text-500">{size}</span>}
							{stopped.has(item.project) && (
								<span
									data-testid="upstream-red-marker"
									className="inline-flex items-center rounded border border-status-red/50 px-1.5 py-0.5 text-[10px] font-medium text-status-red"
								>
									upstream red
								</span>
							)}
							{noTests && <span className={MARKER_CLASS}>no tests</span>}
							{commit?.localTestSkipped === true && (
								<span className={MARKER_CLASS}>local test skipped</span>
							)}
							{commit?.considerSplitting === true && (
								<span className={MARKER_CLASS}>consider splitting</span>
							)}
							{age !== null && <span className="text-xs text-text-500">{age}</span>}
							{action !== null && (
								<button
									type="button"
									disabled={blockedReason !== null}
									title={blockedReason ?? undefined}
									onClick={() => {
										onLand(item, commit);
									}}
									className="ml-auto rounded bg-status-green px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{action.label}
								</button>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
