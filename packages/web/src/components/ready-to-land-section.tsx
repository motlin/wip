import {Link} from "@tanstack/react-router";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {
	commitLookup,
	readyRowView,
	stableRowOrder,
	type ReadyToLandItem,
	type ReadyToLandState,
} from "@wip/shared/ready-to-land.js";
import {wipAgeText} from "../lib/staleness";
import {landOutcomeKey, type ActionOutcome, type ActionOutcomes} from "../lib/action-outcomes";
import {ActionSlot, LandByPushing, LandControl, REVIEW_CLASS, type LandControlProps} from "./land-control.js";

const CHIP_CLASS = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium";
const MARKER_CLASS = `${CHIP_CLASS} border-border-300/60 bg-bg-200/60 text-text-300`;

const NO_OUTCOMES: ActionOutcomes = {};

function sizeText(commit: GitChildResult | undefined): string | null {
	if (commit?.insertions === undefined && commit?.deletions === undefined) return null;
	const files = commit.files ?? 0;
	return `+${commit.insertions ?? 0} −${commit.deletions ?? 0} · ${files} ${files === 1 ? "file" : "files"}`;
}

interface ReadyRowProps extends LandControlProps {
	noTests: boolean;
	age: string | null;
}

function ReadyRow({noTests, age, ...land}: ReadyRowProps) {
	const {item, commit} = land;
	const size = sizeText(commit);
	const params = {project: item.project, sha: commit?.sha ?? item.sha};
	const hasChips =
		noTests ||
		commit?.localTestSkipped === true ||
		commit?.considerSplitting === true ||
		commit?.prUrl !== undefined;
	return (
		<li
			data-testid="ready-to-land-row"
			className="rounded-md border border-border-300/50 bg-bg-000 px-3 py-2.5 shadow-sm transition-colors hover:border-border-300"
		>
			<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
				<div className="min-w-0 flex-1 basis-64">
					<Link
						to="/item/$project/$sha"
						params={params}
						className="line-clamp-2 break-words text-sm font-medium text-text-000 hover:underline"
					>
						{commit?.subject ?? item.sha.slice(0, 7)}
					</Link>
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-text-500">
						<span>{item.project}</span>
						{size !== null && <span>{size}</span>}
						{age !== null && <span>{age}</span>}
						{item.otherBranches !== undefined && (
							<span>branches {[item.branch, ...item.otherBranches].filter(Boolean).join(", ")}</span>
						)}
					</div>
					{hasChips && (
						<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
							{noTests && <span className={MARKER_CLASS}>no tests</span>}
							{commit?.localTestSkipped === true && (
								<span className={MARKER_CLASS}>local test skipped</span>
							)}
							{commit?.considerSplitting === true && (
								<span className={MARKER_CLASS}>consider splitting</span>
							)}
							{commit?.prUrl !== undefined && (
								<a
									href={commit.prUrl}
									target="_blank"
									rel="noreferrer"
									className={`${CHIP_CLASS} border-blue-500/40 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400`}
								>
									PR #{commit.prNumber ?? "?"}
								</a>
							)}
						</div>
					)}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<Link to="/diff/$project/$sha" params={params} className={REVIEW_CLASS}>
						Review
					</Link>
					<LandControl {...land} />
				</div>
			</div>
		</li>
	);
}

/**
 * A PR whose checks still run: one compact line naming it and linking to it on GitHub, from server
 * state (the PR status cache), so it stays findable after a reload. No button until the checks
 * pass; with auto-merge on, GitHub merges it itself.
 */
function WaitingRow({
	item,
	commit,
	failed,
	outcome,
	onDismissOutcome,
	onLandByPushing,
	upstreamBranch,
}: {
	item: ReadyToLandItem;
	commit: GitChildResult | undefined;
	/** Its PR checks failed: the row links to the failing run instead of waiting. */
	failed: boolean;
	outcome: ActionOutcome | undefined;
	onDismissOutcome: (() => void) | undefined;
	/** Set when PR checks can't run (private repo, Actions unavailable for billing). */
	onLandByPushing?: ((project: string) => void) | undefined;
	upstreamBranch: string;
}) {
	const pr = `PR #${commit?.prNumber ?? "?"}`;
	const failedRun = commit?.failedChecks?.find((check) => check.url !== undefined)?.url;
	const linkClass = "font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400";
	return (
		<li
			data-testid={failed ? "checks-failed-row" : "waiting-row"}
			className="rounded-md border border-border-300/50 bg-bg-000 px-3 py-1.5 text-xs text-text-500 shadow-sm"
		>
			<div className="flex items-center gap-2">
				<p className="min-w-0 flex-1 truncate">
					<Link
						to="/item/$project/$sha"
						params={{project: item.project, sha: commit?.sha ?? item.sha}}
						className="font-medium text-text-000 hover:underline"
					>
						{commit?.subject ?? item.sha.slice(0, 7)}
					</Link>
					<span> · {item.project} · </span>
					{commit?.prUrl === undefined ? (
						<span>{pr}</span>
					) : (
						<a href={commit.prUrl} target="_blank" rel="noreferrer" className={linkClass}>
							{pr}
						</a>
					)}
					<span> · </span>
					{failed ? (
						failedRun === undefined ? (
							<span className="text-status-red">checks failed</span>
						) : (
							<a
								href={failedRun}
								target="_blank"
								rel="noreferrer"
								className={`${linkClass} text-status-red`}
							>
								checks failed
							</a>
						)
					) : (
						<span>waiting for checks{commit?.autoMerge === true && ", merges itself when they pass"}</span>
					)}
				</p>
				<ActionSlot outcome={outcome} onDismissOutcome={onDismissOutcome} />
			</div>
			{onLandByPushing !== undefined && (
				<LandByPushing
					project={item.project}
					upstreamBranch={upstreamBranch}
					onLandByPushing={onLandByPushing}
				/>
			)}
		</li>
	);
}

export interface ReadyToLandSectionProps {
	state: ReadyToLandState | null | undefined;
	/** The cached children, joined by project and sha for subject, size and markers. */
	commits: readonly GitChildResult[];
	projects: readonly ProjectInfo[];
	/** Client clock for ages; null during SSR, which omits them. */
	now: number | null;
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
	/** `project:sha` of ready rows whose PR checks can't run (private repo, Actions unavailable for billing). */
	actionsBlocked?: ReadonlySet<string>;
	/** Configures a repo to land by pushing directly; the row asks for a confirm first. */
	onLandByPushing?: (project: string) => void;
	/** Each row's latest action outcome, by landOutcomeKey. */
	outcomes?: ActionOutcomes;
	/** Clears one row's outcome by its key. */
	onDismissOutcome?: (key: string) => void;
}

/**
 * Lean plan step 42: the ready buffer's ready commits, pinned first on /queue, in a stable order
 * (oldest first seen first, stack prefixes before what is stacked on them), each a card with size, age ("in wip Nd" from first seen), markers, a
 * Review link to its diff and the landing action, which lands only after a confirm naming what lands.
 * Its counts, notices and Push main cards head the Ready to Land column (ReadyToLandLead).
 */
export function ReadyToLandSection({
	state,
	commits,
	projects,
	now,
	onLand,
	actionsBlocked,
	onLandByPushing,
	outcomes = NO_OUTCOMES,
	onDismissOutcome,
}: ReadyToLandSectionProps) {
	const dismiss = (key: string) =>
		onDismissOutcome === undefined
			? undefined
			: () => {
					onDismissOutcome(key);
				};
	if (state === undefined) {
		// Not loaded yet: hold the section's place instead of popping in later.
		return (
			<section
				data-testid="ready-to-land-loading"
				className="mb-6 h-24 rounded-lg border border-status-green/40 bg-bg-100 p-4"
			>
				<h2 className="mb-3 text-sm font-semibold">Ready to land</h2>
				<p className="text-xs text-text-500">Loading…</p>
			</section>
		);
	}
	if (state === null) return null;
	const commitOf = commitLookup(commits);
	// A PR whose checks failed never lands, and one whose checks still run shows as waiting unless
	// Merge PR can turn on auto-merge; see readyRowView. Rows keep one stable order across server
	// updates and state changes (see stableRowOrder): no reflow.
	const rows = stableRowOrder([...state.ready, ...(state.awaitingChecks ?? []), ...(state.checksFailed ?? [])]).map(
		(item) => {
			const commit = commitOf(item);
			return {item, commit, view: readyRowView(item, commit)};
		},
	);
	if (rows.length === 0) return null;
	const projectMap = new Map(projects.map((p) => [p.name, p]));

	return (
		<section className="mb-6 rounded-lg border border-status-green/40 bg-bg-100 p-4">
			<h2 className="mb-3 text-sm font-semibold">Ready to land</h2>
			<ul className="flex flex-col gap-2">
				{rows.map(({item, commit, view}) => {
					const outcomeKey = landOutcomeKey(item.project, item.sha);
					const projectInfo = projectMap.get(item.project);
					const landByPushingHere =
						actionsBlocked?.has(`${item.project}:${item.sha}`) === true ? onLandByPushing : undefined;
					if (view !== "land") {
						return (
							<WaitingRow
								key={`${item.project}:${item.id}`}
								item={item}
								commit={commit}
								failed={view === "checks-failed"}
								outcome={outcomes[outcomeKey]}
								onDismissOutcome={dismiss(outcomeKey)}
								onLandByPushing={landByPushingHere}
								upstreamBranch={projectInfo?.upstreamBranch ?? "main"}
							/>
						);
					}
					return (
						<ReadyRow
							key={`${item.project}:${item.id}`}
							item={item}
							commit={commit}
							projectInfo={projectInfo}
							noTests={projectInfo?.hasTestConfigured === false}
							age={now === null || item.firstSeen === undefined ? null : wipAgeText(item.firstSeen, now)}
							onLand={onLand}
							outcome={outcomes[outcomeKey]}
							onDismissOutcome={dismiss(outcomeKey)}
						/>
					);
				})}
			</ul>
		</section>
	);
}

export interface ReadyLandPanelProps {
	state: ReadyToLandState | null | undefined;
	sha: string;
	commit: GitChildResult | undefined;
	projectInfo: ProjectInfo;
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
	/** The commit's latest landing outcome, kept on the panel until its next action. */
	outcome?: ActionOutcome | undefined;
	onDismissOutcome?: (() => void) | undefined;
}

/** The diff page's landing action, so the flow is review then land; only for a ready commit. */
export function ReadyLandPanel({
	state,
	sha,
	commit,
	projectInfo,
	onLand,
	outcome,
	onDismissOutcome,
}: ReadyLandPanelProps) {
	const item = [...(state?.ready ?? []), ...(state?.awaitingChecks ?? []), ...(state?.checksFailed ?? [])].find(
		(r) => r.project === projectInfo.name && r.sha === sha,
	);
	if (!state || item === undefined || readyRowView(item, commit) !== "land") return null;
	return (
		<ReadyLandPanelBody
			item={item}
			commit={commit}
			projectInfo={projectInfo}
			onLand={onLand}
			outcome={outcome}
			onDismissOutcome={onDismissOutcome}
		/>
	);
}

function ReadyLandPanelBody(props: LandControlProps) {
	return (
		<div className="mb-4 rounded-lg border border-status-green/40 bg-bg-100 px-4 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<span className="text-sm font-medium text-text-100">Ready to land</span>
				<LandControl {...props} />
			</div>
		</div>
	);
}
