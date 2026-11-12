import {useState} from "react";
import {Link} from "@tanstack/react-router";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {
	commitLookup,
	landableCount,
	readyRowView,
	stableRowOrder,
	stoppedLineRefusal,
	type ReadyToLandItem,
	type ReadyToLandState,
} from "@wip/shared/ready-to-land.js";
import {greenPrefix, type MainPush, type MainPushCommit} from "@wip/shared/main-push.js";
import {wipAgeText} from "../lib/staleness";
import {landOutcomeKey, pushOutcomeKey, type ActionOutcome, type ActionOutcomes} from "../lib/action-outcomes";
import {
	ActionOutcomeLine,
	ActionSlot,
	CANCEL_CLASS,
	LandByPushing,
	LandControl,
	REVIEW_CLASS,
	type LandControlProps,
} from "./land-control.js";

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

const NO_PUSHES: readonly MainPush[] = [];

const STATUS_WORDS = {good: "green", bad: "red", unknown: "unknown"} as const;

const commitLabel = (c: MainPushCommit): string => `"${c.subject}" (${c.sha.slice(0, 7)})`;

const statusLabel = (c: MainPushCommit): string => `${commitLabel(c)} ${STATUS_WORDS[c.status]}`;

/**
 * The commits after the green prefix, as one line: how many, how many unknown and red, and the first
 * (never green) by name. The full list sits behind a disclosure so a long tail never floods the row.
 */
function NotPushed({rest}: {rest: readonly MainPushCommit[]}) {
	const [first] = rest;
	const unknown = rest.filter((c) => c.status === "unknown").length;
	const red = rest.filter((c) => c.status === "bad").length;
	return (
		<div data-testid="not-pushed" className="mt-0.5 text-text-500">
			<p>
				Not pushed: {rest.length} {rest.length === 1 ? "commit" : "commits"} ({unknown} unknown, {red} red)
				{first !== undefined && `, first ${statusLabel(first)}`}
			</p>
			<details data-testid="not-pushed-all">
				<summary className="cursor-pointer">Show all {rest.length}</summary>
				<ul className="ml-4 list-disc">
					{rest.map((c) => (
						<li key={c.sha}>{statusLabel(c)}</li>
					))}
				</ul>
			</details>
		</div>
	);
}

/**
 * Push main: local main is ahead of its remote. The row offers one confirmed push of the green
 * prefix (oldest first, by `git test results`), whose confirm names exactly those commits and the
 * sha it pushes; the unknown or red tail is listed as not pushed. A diverged main gets no button.
 */
function PushRow({
	push,
	blockedReason,
	onPush,
	outcome,
	onDismissOutcome,
}: {
	push: MainPush;
	/** Why this repo may not push (its upstream is red): shown instead of the button. */
	blockedReason: string | null;
	onPush: (push: MainPush, sha: string) => void;
	outcome: ActionOutcome | undefined;
	onDismissOutcome: (() => void) | undefined;
}) {
	const [confirming, setConfirming] = useState(false);
	const {project, branch, remote} = push;
	const target = `${remote}/${branch}`;
	if (push.diverged) {
		return (
			<li data-testid="push-row" className="px-1 py-1 text-xs text-text-300">
				{project}: local {branch} has diverged from {target}; rebase first
				<ActionOutcomeLine outcome={outcome} onDismiss={onDismissOutcome} />
			</li>
		);
	}
	const {green, rest} = greenPrefix(push.commits);
	const last = green.at(-1);
	const label = `Push ${green.length} green ${green.length === 1 ? "commit" : "commits"} to ${target}`;
	const confirm =
		confirming && last !== undefined ? (
			<div data-testid="push-confirm" className="flex flex-col gap-2">
				<p>
					{label} in {project}: {green.map(commitLabel).join(", ")}. Pushes {last.sha.slice(0, 7)}
					:refs/heads/{branch}, never forced.
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						disabled={outcome?.status === "running"}
						onClick={() => {
							setConfirming(false);
							onPush(push, last.sha);
						}}
						className="rounded-md bg-status-green px-2.5 py-1 font-medium text-white hover:opacity-90"
					>
						Confirm
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirming(false);
						}}
						className={CANCEL_CLASS}
					>
						Cancel
					</button>
				</div>
			</div>
		) : null;
	return (
		<li data-testid="push-row" className="px-1 py-1 text-xs">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="min-w-0 flex-1 basis-64 text-text-100">
					{project}: {green.length} of {push.commits.length} unpushed commits on {branch} are green
					{push.testing !== undefined && ` · testing ${push.testing.slice(0, 7)}`}
				</span>
				<div className="ml-auto">
					<ActionSlot
						confirm={confirm}
						confirmLabel="Confirm push"
						onCancel={() => {
							setConfirming(false);
						}}
						outcome={outcome}
						onDismissOutcome={onDismissOutcome}
					>
						{blockedReason !== null && <span className="text-text-300">{blockedReason}</span>}
						{blockedReason === null && last !== undefined && (
							<button
								type="button"
								disabled={outcome?.status === "running"}
								aria-expanded={confirming}
								onClick={() => {
									setConfirming(true);
								}}
								className="rounded-md bg-status-green px-2 py-0.5 font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{label}
							</button>
						)}
					</ActionSlot>
				</div>
			</div>
			{rest.length > 0 && <NotPushed rest={rest} />}
		</li>
	);
}

/** Push main rows worth showing: diverged, a non-empty green prefix, or a background test running. */
function visiblePushes(pushes: readonly MainPush[]): MainPush[] {
	return pushes.filter(
		(push) => push.diverged || push.testing !== undefined || greenPrefix(push.commits).green.length > 0,
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
	/** Projects whose local main is ahead of its remote, for the Push main group. */
	mainPushes?: readonly MainPush[];
	/** Pushes `sha`, the last commit of a project's green prefix, to its upstream branch. */
	onPush: (push: MainPush, sha: string) => void;
	/** `project:sha` of ready rows whose PR checks can't run (private repo, Actions unavailable for billing). */
	actionsBlocked?: ReadonlySet<string>;
	/** Configures a repo to land by pushing directly; the row asks for a confirm first. */
	onLandByPushing?: (project: string) => void;
	/** Each row's latest action outcome, by landOutcomeKey / pushOutcomeKey. */
	outcomes?: ActionOutcomes;
	/** Clears one row's outcome by its key. */
	onDismissOutcome?: (key: string) => void;
}

/**
 * Lean plan step 42: the ready buffer's ready commits, pinned first on /queue, in a stable order
 * (oldest first seen first, stack prefixes before what is stacked on them), each a card with size, age ("in wip Nd" from first seen), markers, a
 * Review link to its diff and the landing action, which lands only after a confirm naming what lands.
 * Projects whose local main is ahead of its remote get a compact Push main group below the commits.
 */
export function ReadyToLandSection({
	state,
	commits,
	projects,
	now,
	onLand,
	mainPushes = NO_PUSHES,
	onPush,
	actionsBlocked,
	onLandByPushing,
	outcomes = NO_OUTCOMES,
	onDismissOutcome,
}: ReadyToLandSectionProps) {
	const pushes = visiblePushes(mainPushes);
	// A push whose row left (every green commit pushed) keeps its outcome as a line of its own.
	const shownPushes = new Set(pushes.map((push) => push.project));
	const leftPushes = Object.keys(outcomes)
		.filter((key) => key.startsWith("push:"))
		.map((key) => key.slice("push:".length))
		.filter((project) => !shownPushes.has(project));
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
	const paused = state.pausedOnBattery === true;
	const verifyNotices = state.verifyNotices ?? [];
	if (
		rows.length === 0 &&
		state.inFlight.length === 0 &&
		pushes.length === 0 &&
		leftPushes.length === 0 &&
		!paused &&
		verifyNotices.length === 0
	) {
		return null;
	}
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	const landable = landableCount(state, commits);

	return (
		<section className="mb-6 rounded-lg border border-status-green/40 bg-bg-100 p-4">
			<h2 data-testid="ready-to-land-heading" className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
				<span>Ready to land</span>
				<span className="text-xs font-normal tabular-nums text-text-500">
					{landable} ready (target {state.slots}) · {state.inFlight.length} readying
				</span>
			</h2>
			{paused && (
				<p data-testid="ready-to-land-paused" className="mb-2 text-xs text-text-300">
					Paused on battery: background tests resume when the Mac is plugged in.
				</p>
			)}
			{verifyNotices.map((notice) => (
				<p
					key={`${notice.project}:${notice.reason}`}
					data-testid="ready-to-land-verify-notice"
					className="mb-2 text-xs text-text-300"
				>
					{notice.project}: {notice.reason}
				</p>
			))}
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
			{(pushes.length > 0 || leftPushes.length > 0) && (
				<div data-testid="push-main-group" className="mt-3 border-t border-border-300/50 pt-2">
					<h3 className="mb-1 px-1 text-xs font-semibold text-text-300">Push main</h3>
					<ul className="flex flex-col">
						{pushes.map((push) => (
							<PushRow
								key={`push:${push.project}`}
								push={push}
								blockedReason={stoppedLineRefusal(push.project, state.stoppedProjects)}
								onPush={onPush}
								outcome={outcomes[pushOutcomeKey(push.project)]}
								onDismissOutcome={dismiss(pushOutcomeKey(push.project))}
							/>
						))}
						{leftPushes.map((project) => (
							<li key={`push:${project}`} data-testid="push-row" className="px-1 py-1 text-xs">
								<ActionOutcomeLine
									outcome={outcomes[pushOutcomeKey(project)]}
									onDismiss={dismiss(pushOutcomeKey(project))}
									prefix={`${project}: `}
								/>
							</li>
						))}
					</ul>
				</div>
			)}
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
