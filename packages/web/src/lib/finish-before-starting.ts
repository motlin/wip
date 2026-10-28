import type {FlowCounts} from "@wip/shared/flow-counts.js";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";

/**
 * Lean plan step 49: whether any commit is waiting (red, ready, or in the ready buffer). While one
 * is, starting a todo is de-emphasised so finishing comes before starting; it stays enabled.
 */
export function commitsWaiting(
	counts: Pick<FlowCounts, "red" | "ready">,
	readyToLand: ReadyToLandState | null | undefined,
): boolean {
	return (
		counts.red > 0 ||
		counts.ready > 0 ||
		(readyToLand?.ready.length ?? 0) > 0 ||
		(readyToLand?.inFlight.length ?? 0) > 0
	);
}
