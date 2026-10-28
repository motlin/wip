import {useQuery} from "@tanstack/react-query";
import {readyToLandQueryOptions} from "../lib/queries";
import {useHydrated} from "../lib/use-hydrated.js";

/**
 * The andon: on every page, the projects whose own upstream is red (stopsLine), as the ready
 * buffer last reported them. A foreign red upstream is the baseline and never shows here.
 * The query is client-only (the persister restores it before hydration), so it stays hidden
 * until hydrated to keep the hydration render identical to the server HTML.
 */
export function AndonBanner() {
	const hydrated = useHydrated();
	const {data} = useQuery(readyToLandQueryOptions());
	const stopped = (hydrated ? data?.stoppedProjects : undefined) ?? [];
	if (stopped.length === 0) return null;

	return (
		<div
			role="alert"
			className="border-b border-status-red/50 bg-status-red/10 px-6 py-2 text-sm font-medium text-status-red"
		>
			Line stopped: upstream red in {stopped.join(", ")}
		</div>
	);
}
