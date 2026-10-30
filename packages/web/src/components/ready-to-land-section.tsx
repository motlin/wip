import {useState} from "react";
import {Link} from "@tanstack/react-router";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {
	landingOrder,
	openPrRefusal,
	prChecksPending,
	readyRowView,
	type ReadyToLandItem,
	type ReadyToLandState,
} from "@wip/shared/ready-to-land.js";
import {greenPrefix, type MainPush, type MainPushCommit} from "@wip/shared/main-push.js";
import {wipAgeText} from "../lib/staleness";
import {landOutcomeKey, pushOutcomeKey, type ActionOutcome, type ActionOutcomes} from "../lib/action-outcomes";
import {Loader2} from "./icons.js";

const CHIP_CLASS = "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium";
const MARKER_CLASS = `${CHIP_CLASS} border-border-300/60 bg-bg-200/60 text-text-300`;
const CANCEL_CLASS = "rounded-md border border-border-300 px-2.5 py-1 font-medium text-text-300 hover:bg-bg-200";

/**
 * The row's next step: in a pull-request repo, merge its PR, or open one when it has none yet (a
 * PR the user clicks to open is user-initiated); fast-forward local main otherwise (never a push:
 * pushing main is the separate Push step). Null only when a
 * pull-request repo's commit has no branch to open a PR from. `autoMerge` marks a step that turns on
 * auto-merge (the repo allows it): Open PR, and Merge PR while the checks still run.
 */
export type LandingAction =
	| {kind: "merge-pr"; label: string; prNumber: number; autoMerge: boolean}
	| {kind: "open-pr"; label: string; branch: string; autoMerge: boolean}
	| {kind: "fast-forward"; label: string};

export function landingAction(
	item: ReadyToLandItem,
	commit: GitChildResult | undefined,
	upstreamBranch = "main",
): LandingAction | null {
	if (item.landing !== "pull-request") return {kind: "fast-forward", label: `Fast-forward ${upstreamBranch}`};
	const autoMergeAllowed = commit?.autoMergeAllowed === true;
	if (commit?.prNumber !== undefined) {
		return {
			kind: "merge-pr",
			label: `Merge PR #${commit.prNumber}`,
			prNumber: commit.prNumber,
			autoMerge: autoMergeAllowed && prChecksPending(commit),
		};
	}
	const branch = item.branch ?? commit?.branch;
	return branch === undefined ? null : {kind: "open-pr", label: "Open PR", branch, autoMerge: autoMergeAllowed};
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

/** What the confirm names: the commit, its sha, its repo, and where it goes. */
function LandingPrompt({
	action,
	item,
	commit,
	projectInfo,
}: {
	action: LandingAction;
	item: ReadyToLandItem;
	commit: GitChildResult | undefined;
	projectInfo: ProjectInfo | undefined;
}) {
	const what = `"${commit?.subject ?? item.sha.slice(0, 7)}" (${item.sha.slice(0, 7)})`;
	if (action.kind === "merge-pr") {
		const pr = `PR #${action.prNumber}`;
		return (
			<>
				Merge{" "}
				{commit?.prUrl === undefined ? (
					pr
				) : (
					<a
						href={commit.prUrl}
						target="_blank"
						rel="noreferrer"
						className="text-blue-600 underline dark:text-blue-400"
					>
						{pr}
					</a>
				)}{" "}
				for {what} in {item.project}.
				{action.autoMerge && " Its checks are still running: it will merge itself when they pass."}
			</>
		);
	}
	if (action.kind === "open-pr") {
		return (
			<>
				Open a PR for {what} from branch {action.branch} in {item.project}.
				{action.autoMerge && " It will merge itself when its checks pass."}
			</>
		);
	}
	const branch = projectInfo?.upstreamBranch ?? "main";
	return (
		<>
			Fast-forward {branch} in {item.project} to {what}. Local {branch} moves to {item.sha.slice(0, 7)}. Nothing
			is pushed.
		</>
	);
}

const OUTCOME_STYLES: Record<ActionOutcome["status"], string> = {
	running: "text-text-300",
	success: "text-status-green",
	failure: "text-status-red",
};

const NO_OUTCOMES: ActionOutcomes = {};

/**
 * A row's latest action outcome, kept until its next action replaces it: in progress with a
 * spinner, success with where to find the result, or failure with a short reason and the log.
 */
function ActionOutcomeLine({
	outcome,
	onDismiss,
	prefix,
}: {
	outcome: ActionOutcome | undefined;
	onDismiss?: (() => void) | undefined;
	prefix?: string;
}) {
	if (outcome === undefined) return null;
	const link = outcome.status === "running" ? undefined : outcome.link;
	return (
		<output
			data-testid="action-outcome"
			className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${OUTCOME_STYLES[outcome.status]}`}
		>
			{outcome.status === "running" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
			<span className="font-medium">
				{prefix}
				{outcome.message}
			</span>
			{outcome.status === "failure" && outcome.detail !== undefined && (
				<span className="min-w-0 break-words text-text-300">{outcome.detail}</span>
			)}
			{link !== undefined && (
				<a
					href={link.href}
					{...(/^https?:\/\//.test(link.href) ? {target: "_blank", rel: "noreferrer"} : {})}
					className="font-medium text-blue-600 underline underline-offset-2 dark:text-blue-400"
				>
					{link.label}
				</a>
			)}
			{outcome.status !== "running" && onDismiss !== undefined && (
				<button type="button" onClick={onDismiss} className="ml-auto text-text-500 hover:text-text-100">
					Dismiss
				</button>
			)}
		</output>
	);
}

interface LandControlProps {
	item: ReadyToLandItem;
	commit: GitChildResult | undefined;
	projectInfo: ProjectInfo | undefined;
	blockedReason: string | null;
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
	/** The row's latest landing outcome; the button waits while one is in progress. */
	outcome?: ActionOutcome | undefined;
	onDismissOutcome?: (() => void) | undefined;
}

/** The landing button plus the confirm it opens; nothing lands until the user confirms. */
function useLandControl({item, commit, projectInfo, blockedReason, onLand, outcome}: LandControlProps) {
	const running = outcome?.status === "running";
	const [confirming, setConfirming] = useState(false);
	const landing = landingAction(item, commit, projectInfo?.upstreamBranch);
	// An Open PR the server would refuse is never offered: the row says why instead.
	const refusal =
		landing?.kind === "open-pr" ? openPrRefusal(landing.branch, projectInfo?.upstreamBranch ?? "main") : null;
	const action = refusal === null ? landing : null;
	const button =
		refusal === null ? (
			action === null ? null : (
				<button
					type="button"
					disabled={blockedReason !== null || running}
					title={blockedReason ?? undefined}
					aria-expanded={confirming}
					onClick={() => {
						setConfirming(true);
					}}
					className="rounded-md bg-status-green px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{action.label}
				</button>
			)
		) : (
			<span className="text-xs text-text-300">{refusal}</span>
		);
	const confirm =
		action === null || !confirming ? null : (
			<div
				data-testid="land-confirm"
				aria-label="Confirm landing"
				className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-status-green/40 bg-status-green/5 px-3 py-2 text-xs text-text-100"
			>
				<p className="min-w-0 flex-1 basis-60">
					<LandingPrompt action={action} item={item} commit={commit} projectInfo={projectInfo} />
				</p>
				<div className="flex gap-2">
					<button
						type="button"
						disabled={blockedReason !== null || running}
						onClick={() => {
							setConfirming(false);
							onLand(item, commit);
						}}
						className="rounded-md bg-status-green px-2.5 py-1 font-medium text-white hover:opacity-90 disabled:opacity-40"
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
		);
	return {button, confirm};
}

/**
 * Ready rows worth asking GitHub whether Actions refused to run for billing: pull-request rows whose
 * PR checks failed. Every other row keeps its landing action as is.
 */
export function billingCheckCandidates(
	state: ReadyToLandState | null | undefined,
	commits: readonly GitChildResult[],
): ReadyToLandItem[] {
	if (!state) return [];
	const byKey = new Map(commits.map((c) => [`${c.project}:${c.sha}`, c]));
	return state.ready.filter((item) => {
		const commit = byKey.get(`${item.project}:${item.sha}`);
		return item.landing === "pull-request" && commit?.prNumber !== undefined && commit.checkStatus === "failed";
	});
}

/**
 * A pull-request row whose checks can't run (private repo, Actions unavailable for billing): says
 * so, and offers the one switch to push-based landing for this repo, written only after a confirm.
 */
function LandByPushing({
	project,
	upstreamBranch,
	onLandByPushing,
}: {
	project: string;
	upstreamBranch: string;
	onLandByPushing: (project: string) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<div className="mt-2 flex flex-col gap-2 text-xs text-text-300">
			<div className="flex flex-wrap items-center gap-2">
				<p className="min-w-0 flex-1 basis-60">
					PR checks can't run: {project} is a private repo and its GitHub Actions are unavailable for billing.
				</p>
				<button
					type="button"
					aria-expanded={confirming}
					onClick={() => {
						setConfirming(true);
					}}
					className={REVIEW_CLASS}
				>
					Land this repo by pushing directly instead
				</button>
			</div>
			{confirming && (
				<div
					data-testid="land-by-pushing-confirm"
					aria-label="Confirm landing by pushing"
					className="flex flex-wrap items-center gap-2 rounded-md border border-border-300 bg-bg-100 px-3 py-2 text-text-100"
				>
					<p className="min-w-0 flex-1 basis-60">
						Configure {project} to land by pushing directly: its ready commits Fast-forward {upstreamBranch}
						, then you Push {upstreamBranch}. No pull requests. Saved to the registry.
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => {
								setConfirming(false);
								onLandByPushing(project);
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
			)}
		</div>
	);
}

const REVIEW_CLASS =
	"rounded-md border border-border-300 px-2.5 py-1 text-xs font-medium text-text-100 hover:bg-bg-200 hover:text-text-000";

interface ReadyRowProps extends LandControlProps {
	stoppedLine: boolean;
	noTests: boolean;
	age: string | null;
	/** Set when PR checks can't run (private repo, Actions unavailable for billing). */
	onLandByPushing?: ((project: string) => void) | undefined;
}

function ReadyRow({stoppedLine, noTests, age, onLandByPushing, ...land}: ReadyRowProps) {
	const {item, commit} = land;
	const {button, confirm} = useLandControl(land);
	const size = sizeText(commit);
	const params = {project: item.project, sha: item.sha};
	const hasChips =
		stoppedLine ||
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
							{stoppedLine && (
								<span
									data-testid="upstream-red-marker"
									className={`${CHIP_CLASS} border-status-red/50 bg-status-red/10 text-status-red`}
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
					{button}
				</div>
			</div>
			{onLandByPushing !== undefined && (
				<LandByPushing
					project={item.project}
					upstreamBranch={land.projectInfo?.upstreamBranch ?? "main"}
					onLandByPushing={onLandByPushing}
				/>
			)}
			{confirm}
			<ActionOutcomeLine outcome={land.outcome} onDismiss={land.onDismissOutcome} />
		</li>
	);
}

const NO_PUSHES: readonly MainPush[] = [];

const STATUS_WORDS = {good: "green", bad: "red", unknown: "unknown"} as const;

const commitLabel = (c: MainPushCommit): string => `"${c.subject}" (${c.sha.slice(0, 7)})`;

/**
 * Push main: local main is ahead of its remote. The row offers one confirmed push of the green
 * prefix (oldest first, by `git test results`), whose confirm names exactly those commits and the
 * sha it pushes; the unknown or red tail is listed as not pushed. A diverged main gets no button.
 */
function PushRow({
	push,
	onPush,
	outcome,
	onDismissOutcome,
}: {
	push: MainPush;
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
	return (
		<li data-testid="push-row" className="px-1 py-1 text-xs">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="min-w-0 flex-1 basis-64 text-text-100">
					{project}: {green.length} of {push.commits.length} unpushed commits on {branch} are green
					{push.testing !== undefined && ` · testing ${push.testing.slice(0, 7)}`}
				</span>
				{last !== undefined && (
					<button
						type="button"
						disabled={outcome?.status === "running"}
						aria-expanded={confirming}
						onClick={() => {
							setConfirming(true);
						}}
						className="ml-auto rounded-md bg-status-green px-2 py-0.5 font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{label}
					</button>
				)}
			</div>
			{rest.length > 0 && (
				<p className="mt-0.5 text-text-500">
					Not pushed: {rest.map((c) => `${commitLabel(c)} ${STATUS_WORDS[c.status]}`).join(", ")}
				</p>
			)}
			{confirming && last !== undefined && (
				<div
					data-testid="push-confirm"
					aria-label="Confirm push"
					className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-status-green/40 bg-status-green/5 px-3 py-2 text-text-100"
				>
					<p className="min-w-0 flex-1 basis-60">
						{label} in {project}: {green.map(commitLabel).join(", ")}. Pushes {last.sha.slice(0, 7)}
						:refs/heads/{branch}, never forced.
					</p>
					<div className="flex gap-2">
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
			)}
			<ActionOutcomeLine outcome={outcome} onDismiss={onDismissOutcome} />
		</li>
	);
}

/** Push main rows worth showing: diverged, a non-empty green prefix, or a background test running. */
function visiblePushes(pushes: readonly MainPush[]): MainPush[] {
	return pushes.filter(
		(push) => push.diverged || push.testing !== undefined || greenPrefix(push.commits).green.length > 0,
	);
}

/** A PR with auto-merge on: GitHub merges it once its checks pass, so there is nothing to click. */
function MergingRow({
	item,
	commit,
	outcome,
	onDismissOutcome,
}: {
	item: ReadyToLandItem;
	commit: GitChildResult | undefined;
	outcome: ActionOutcome | undefined;
	onDismissOutcome: (() => void) | undefined;
}) {
	return (
		<li
			data-testid="merging-row"
			className="rounded-md border border-border-300/50 bg-bg-000 px-3 py-2.5 shadow-sm transition-colors hover:border-border-300"
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<div className="min-w-0 flex-1 basis-64">
					<Link
						to="/item/$project/$sha"
						params={{project: item.project, sha: item.sha}}
						className="line-clamp-2 break-words text-sm font-medium text-text-000 hover:underline"
					>
						{commit?.subject ?? item.sha.slice(0, 7)}
					</Link>
					<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-500">
						<span>{item.project}</span>
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
				</div>
				<span className="ml-auto text-xs text-text-300">Merging when checks pass</span>
			</div>
			<ActionOutcomeLine outcome={outcome} onDismiss={onDismissOutcome} />
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
 * Lean plan step 42: the ready buffer's ready commits, pinned first on /queue, in landing order
 * (stack prefixes first), each a card with size, age ("in wip Nd" from first seen), markers, a
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
	if (!state) return null;
	const byKey = new Map(commits.map((c) => [`${c.project}:${c.sha}`, c]));
	// A PR whose checks still run shows only when it merges itself or can be told to; see readyRowView.
	const rows = landingOrder([...state.ready, ...(state.awaitingChecks ?? [])]).flatMap((item) => {
		const commit = byKey.get(`${item.project}:${item.sha}`);
		const view = readyRowView(item, commit);
		return view === "hidden" ? [] : [{item, commit, view}];
	});
	if (rows.length === 0 && state.inFlight.length === 0 && pushes.length === 0 && leftPushes.length === 0) {
		return null;
	}
	const projectMap = new Map(projects.map((p) => [p.name, p]));
	const stopped = new Set(state.stoppedProjects);
	const landable = rows.filter((row) => row.view === "land").length;

	return (
		<section className="mb-6 rounded-lg border border-status-green/40 bg-bg-100 p-4">
			<h2 data-testid="ready-to-land-heading" className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
				<span>Ready to land</span>
				<span className="text-xs font-normal tabular-nums text-text-500">
					{landable} ready (target {state.slots}) · {state.inFlight.length} readying
				</span>
			</h2>
			<ul className="flex flex-col gap-2">
				{rows.map(({item, commit, view}) => {
					const outcomeKey = landOutcomeKey(item.project, item.sha);
					if (view === "merging") {
						return (
							<MergingRow
								key={`${item.project}:${item.id}`}
								item={item}
								commit={commit}
								outcome={outcomes[outcomeKey]}
								onDismissOutcome={dismiss(outcomeKey)}
							/>
						);
					}
					const projectInfo = projectMap.get(item.project);
					return (
						<ReadyRow
							key={`${item.project}:${item.id}`}
							item={item}
							commit={commit}
							projectInfo={projectInfo}
							blockedReason={stoppedLineReason(item.project, stopped, commit)}
							stoppedLine={stopped.has(item.project)}
							noTests={projectInfo?.hasTestConfigured === false}
							age={now === null || item.firstSeen === undefined ? null : wipAgeText(item.firstSeen, now)}
							onLand={onLand}
							outcome={outcomes[outcomeKey]}
							onDismissOutcome={dismiss(outcomeKey)}
							onLandByPushing={
								actionsBlocked?.has(`${item.project}:${item.sha}`) === true
									? onLandByPushing
									: undefined
							}
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
	const item = [...(state?.ready ?? []), ...(state?.awaitingChecks ?? [])].find(
		(r) => r.project === projectInfo.name && r.sha === sha,
	);
	if (!state || item === undefined || readyRowView(item, commit) !== "land") return null;
	return (
		<ReadyLandPanelBody
			item={item}
			commit={commit}
			projectInfo={projectInfo}
			blockedReason={stoppedLineReason(item.project, new Set(state.stoppedProjects), commit)}
			onLand={onLand}
			outcome={outcome}
			onDismissOutcome={onDismissOutcome}
		/>
	);
}

function ReadyLandPanelBody(props: LandControlProps) {
	const {button, confirm} = useLandControl(props);
	return (
		<div className="mb-4 rounded-lg border border-status-green/40 bg-bg-100 px-4 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<span className="text-sm font-medium text-text-100">Ready to land</span>
				{button}
			</div>
			{confirm}
			<ActionOutcomeLine outcome={props.outcome} onDismiss={props.onDismissOutcome} />
		</div>
	);
}
