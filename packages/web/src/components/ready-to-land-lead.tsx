import type {LandContextValue} from "../lib/land-context.js";
import {PushMainCards} from "./push-main-card.js";

/**
 * What heads the Ready to Land column, shown even when the column holds no card: the ready buffer's
 * "n ready (target k) · m readying", Paused on battery, the buffer's notices (draft-PR verification
 * not in effect, untrusted repos), then one Push main card per project, first in the column.
 */
export function ReadyToLandLead({land, project}: {land: LandContextValue; project: string | null}) {
	const {state} = land;
	if (state === null || state === undefined) return null;
	return (
		<>
			<p data-testid="ready-to-land-heading" className="text-xs tabular-nums text-text-500">
				{land.landable} ready (target {state.slots}) · {state.inFlight.length} readying
			</p>
			{state.pausedOnBattery === true && (
				<p data-testid="ready-to-land-paused" className="text-xs text-text-300">
					Paused on battery: background tests resume when the Mac is plugged in.
				</p>
			)}
			{(state.verifyNotices ?? []).map((notice) => (
				<p
					key={`${notice.project}:${notice.reason}`}
					data-testid="ready-to-land-verify-notice"
					className="text-xs text-text-300"
				>
					{notice.project}: {notice.reason}
				</p>
			))}
			<PushMainCards
				pushes={land.mainPushes}
				project={project}
				stoppedProjects={state.stoppedProjects}
				onPush={land.onPush}
				outcomes={land.outcomes}
				onDismissOutcome={land.onDismissOutcome}
			/>
		</>
	);
}
