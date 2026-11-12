import {useEffect, useRef, useState, type ReactNode} from "react";
import type {GitChildResult, ProjectInfo} from "@wip/shared";
import {
	commitLookup,
	openPrRefusal,
	prChecksFailed,
	prChecksPending,
	readyRowView,
	type ReadyToLandItem,
	type ReadyToLandState,
} from "@wip/shared/ready-to-land.js";
import type {ActionOutcome} from "../lib/action-outcomes";
import {Loader2} from "./icons.js";

export const CANCEL_CLASS = "rounded-md border border-border-300 px-2.5 py-1 font-medium text-text-300 hover:bg-bg-200";

const REVIEW_CLASS =
	"rounded-md border border-border-300 px-2.5 py-1 text-xs font-medium text-text-100 hover:bg-bg-200 hover:text-text-000";

/**
 * The row's next step: in a pull-request repo, merge its PR, or open one when it has none yet (a
 * PR the user clicks to open is user-initiated); fast-forward local main otherwise (never a push:
 * pushing main is the separate Push step). Null only when a
 * pull-request repo's commit has no branch to open a PR from. `autoMerge` marks a step that turns on
 * auto-merge (the repo allows it): Open PR, and Merge PR while the checks still run. A commit whose PR is
 * still a draft (draft-PR verification opened it) offers Open PR too, which marks that draft ready
 * (`draftPrNumber`) instead of opening another.
 */
export type LandingAction =
	| {kind: "merge-pr"; label: string; prNumber: number; autoMerge: boolean}
	| {kind: "open-pr"; label: string; branch: string; autoMerge: boolean; draftPrNumber?: number}
	| {kind: "fast-forward"; label: string};

export function landingAction(
	item: ReadyToLandItem,
	commit: GitChildResult | undefined,
	upstreamBranch = "main",
): LandingAction | null {
	if (item.landing !== "pull-request") return {kind: "fast-forward", label: `Fast-forward ${upstreamBranch}`};
	const autoMergeAllowed = commit?.autoMergeAllowed === true;
	const draftBranch = item.branch ?? commit?.branch;
	if (commit?.prNumber !== undefined && commit.mergeStateStatus === "DRAFT" && draftBranch !== undefined) {
		return {
			kind: "open-pr",
			label: "Open PR",
			branch: draftBranch,
			autoMerge: autoMergeAllowed,
			draftPrNumber: commit.prNumber,
		};
	}
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
	if (action.kind === "open-pr" && action.draftPrNumber !== undefined) {
		return (
			<>
				Mark draft PR #{action.draftPrNumber} for {what} ready for review in {item.project}.
				{action.autoMerge && " It will merge itself when its checks pass."}
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

/**
 * A row's latest action outcome, kept until its next action replaces it: in progress with a
 * spinner, success with where to find the result, or failure with a short reason and the log.
 */
export function ActionOutcomeLine({
	outcome,
	onDismiss,
	prefix,
	className = "mt-2",
}: {
	outcome: ActionOutcome | undefined;
	onDismiss?: (() => void) | undefined;
	prefix?: string;
	className?: string;
}) {
	if (outcome === undefined) return null;
	const link = outcome.status === "running" ? undefined : outcome.link;
	return (
		<output
			data-testid="action-outcome"
			className={`${className} flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${OUTCOME_STYLES[outcome.status]}`}
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

/**
 * An overlay anchored to a row's action button (absolutely positioned, so opening it, its progress
 * and its result never change the row's height or move the page). Escape closes it when `onClose`
 * is set; a click outside closes it too when `closeOnOutside` is set.
 */
/** "end": the overlay's right edge lines up with its button's (rows, whose button sits at their right); "start": its left edge. */
export type PopoverAlign = "start" | "end";

const ALIGN_CLASS: Record<PopoverAlign, string> = {start: "left-0 right-auto", end: "left-auto right-0"};

function ActionPopover({
	label,
	onClose,
	closeOnOutside = false,
	align = "end",
	children,
}: {
	label: string;
	align?: PopoverAlign | undefined;
	onClose?: (() => void) | undefined;
	closeOnOutside?: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (onClose === undefined) return undefined;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onMouseDown = (event: MouseEvent) => {
			const inside = event.target instanceof Node && ref.current?.contains(event.target) === true;
			if (closeOnOutside && !inside) onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("mousedown", onMouseDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("mousedown", onMouseDown);
		};
	}, [onClose, closeOnOutside]);
	return (
		// A non-modal <dialog open>: the UA centers it, so the anchor's corner is set explicitly.
		<dialog
			ref={ref}
			open
			aria-label={label}
			className={`absolute ${ALIGN_CLASS[align]} top-full z-20 m-0 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-left text-xs font-normal text-text-100 shadow-lg`}
		>
			{children}
		</dialog>
	);
}

/**
 * A row's action and the overlay it opens: the confirm while confirming, otherwise the latest
 * outcome (in progress until it finishes; a success closes on Escape or a click outside; a failure
 * stays, with its log, until dismissed).
 */
export function ActionSlot({
	children,
	confirm,
	confirmLabel,
	onCancel,
	outcome,
	onDismissOutcome,
	align,
}: {
	children?: ReactNode;
	align?: PopoverAlign | undefined;
	confirm?: ReactNode;
	confirmLabel?: string;
	onCancel?: () => void;
	outcome: ActionOutcome | undefined;
	onDismissOutcome: (() => void) | undefined;
}) {
	return (
		<div className="relative flex shrink-0 items-center">
			{children}
			{confirm !== undefined && confirm !== null ? (
				<ActionPopover label={confirmLabel ?? "Confirm"} onClose={onCancel} closeOnOutside align={align}>
					{confirm}
				</ActionPopover>
			) : (
				outcome !== undefined && (
					<ActionPopover
						label="Action result"
						align={align}
						onClose={outcome.status === "success" ? onDismissOutcome : undefined}
						closeOnOutside={outcome.status === "success"}
					>
						<ActionOutcomeLine outcome={outcome} onDismiss={onDismissOutcome} className="" />
					</ActionPopover>
				)
			)}
		</div>
	);
}

export interface LandControlProps {
	item: ReadyToLandItem;
	commit: GitChildResult | undefined;
	projectInfo: ProjectInfo | undefined;
	onLand: (item: ReadyToLandItem, commit: GitChildResult | undefined) => void;
	/** The row's latest landing outcome; the button waits while one is in progress. */
	outcome?: ActionOutcome | undefined;
	onDismissOutcome?: (() => void) | undefined;
	/** Which edge of the button its overlays line up with: "start" on a card, whose button sits at its left. */
	align?: PopoverAlign | undefined;
}

/**
 * The landing button plus the overlay it opens (the confirm, then the outcome); nothing lands until
 * the user confirms.
 */
export function LandControl({item, commit, projectInfo, onLand, outcome, onDismissOutcome, align}: LandControlProps) {
	const running = outcome?.status === "running";
	const [confirming, setConfirming] = useState(false);
	const landing = landingAction(item, commit, projectInfo?.upstreamBranch);
	// An Open PR the server would refuse is never offered: the row says why instead.
	const refusal =
		landing?.kind === "open-pr" ? openPrRefusal(landing.branch, projectInfo?.upstreamBranch ?? "main") : null;
	if (refusal !== null) return <span className="text-xs text-text-300">{refusal}</span>;
	if (landing === null) return null;
	const confirm = confirming ? (
		<div data-testid="land-confirm" className="flex flex-col gap-2">
			<p>
				<LandingPrompt action={landing} item={item} commit={commit} projectInfo={projectInfo} />
			</p>
			<div className="flex justify-end gap-2">
				<button
					type="button"
					disabled={running}
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
	) : null;
	return (
		<ActionSlot
			confirm={confirm}
			confirmLabel="Confirm landing"
			onCancel={() => {
				setConfirming(false);
			}}
			outcome={outcome}
			onDismissOutcome={onDismissOutcome}
			align={align}
		>
			<button
				type="button"
				disabled={running}
				aria-expanded={confirming}
				onClick={() => {
					setConfirming(true);
				}}
				className="rounded-md bg-status-green px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
			>
				{landing.label}
			</button>
		</ActionSlot>
	);
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
	const commitOf = commitLookup(commits);
	return [...state.ready, ...(state.checksFailed ?? [])].filter((item) => {
		const commit = commitOf(item);
		return item.landing === "pull-request" && commit !== undefined && prChecksFailed(commit);
	});
}

/**
 * A pull-request row whose checks can't run (private repo, Actions unavailable for billing): says
 * so, and offers the one switch to push-based landing for this repo, written only after a confirm.
 */
export function LandByPushing({
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
