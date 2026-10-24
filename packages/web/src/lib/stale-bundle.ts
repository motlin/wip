import {pushToast} from "./toast-store.js";

const STALE_BUNDLE_MESSAGE = "Server function info not found";

/**
 * A tab loaded before a server rebuild calls server functions by ids the new
 * server no longer knows. Retrying or polling can never succeed.
 */
export function isStaleBundleError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE_BUNDLE_MESSAGE);
}

let reported = false;

/** Prompt a reload once per page when a query hits the stale-bundle error. */
export function reportStaleBundle(error: unknown): void {
	if (reported || !isStaleBundleError(error)) return;
	reported = true;
	pushToast({level: "warning", message: "The server was updated. Reload the page to pick up the new version."});
}

export function resetStaleBundleReport(): void {
	reported = false;
}
