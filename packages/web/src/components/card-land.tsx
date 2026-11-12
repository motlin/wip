import type {GitChildResult} from "@wip/shared";
import {readyRowView, type ReadyEntry} from "@wip/shared/ready-to-land.js";
import {landOutcomeKey} from "../lib/action-outcomes";
import type {LandContextValue} from "../lib/land-context";
import {ActionSlot, LandByPushing, LandControl} from "./land-control.js";

const CHIP_CLASS =
	"inline-flex items-center rounded border border-border-300/50 px-1.5 py-0.5 text-[10px] font-medium text-text-400";
const LINK_CLASS = "font-medium underline underline-offset-2";

/**
 * A card's landing step, for the card at its ready buffer row's sha: the land button (Open PR,
 * Merge PR or Fast-forward, behind a confirm) when it can land, a waiting chip while its PR checks
 * run, or a link to the failing run when they failed (plus Land by pushing where billing blocks
 * GitHub Actions). Chips mark a draft PR and auto-merge.
 */
export function CardLand({commit, entry, land}: {commit: GitChildResult; entry: ReadyEntry; land: LandContextValue}) {
	const {item} = entry;
	const projectInfo = land.projects.find((p) => p.name === item.project);
	const outcomeKey = landOutcomeKey(item.project, item.sha);
	const outcome = land.outcomes[outcomeKey];
	const dismiss = () => {
		land.onDismissOutcome(outcomeKey);
	};
	const view = readyRowView(item, commit);
	const failedRun = commit.failedChecks?.find((check) => check.url !== undefined)?.url;
	return (
		<>
			{commit.prNumber !== undefined && commit.mergeStateStatus === "DRAFT" && (
				<span data-testid="land-draft-chip" className={CHIP_CLASS}>
					draft
				</span>
			)}
			{commit.autoMerge === true && (
				<span data-testid="land-auto-merge-chip" className={CHIP_CLASS}>
					auto-merge
				</span>
			)}
			{view === "land" && (
				<LandControl
					item={item}
					commit={commit}
					projectInfo={projectInfo}
					onLand={land.onLand}
					outcome={outcome}
					onDismissOutcome={dismiss}
					align="start"
				/>
			)}
			{view === "waiting" && (
				<>
					<span data-testid="land-waiting-chip" className={CHIP_CLASS}>
						waiting for checks
					</span>
					<ActionSlot outcome={outcome} onDismissOutcome={dismiss} align="start" />
				</>
			)}
			{view === "checks-failed" && (
				<>
					{failedRun === undefined ? (
						<span data-testid="land-checks-failed-chip" className={`${CHIP_CLASS} text-status-red`}>
							checks failed
						</span>
					) : (
						<a
							href={failedRun}
							target="_blank"
							rel="noreferrer"
							className={`${LINK_CLASS} text-xs text-status-red`}
						>
							checks failed
						</a>
					)}
					<ActionSlot outcome={outcome} onDismissOutcome={dismiss} align="start" />
				</>
			)}
			{view === "checks-failed" && land.actionsBlocked.has(`${item.project}:${item.sha}`) && (
				<LandByPushing
					project={item.project}
					upstreamBranch={projectInfo?.upstreamBranch ?? "main"}
					onLandByPushing={land.onLandByPushing}
				/>
			)}
		</>
	);
}
