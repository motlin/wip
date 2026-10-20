import {pushToast} from "./toast-store.js";

/**
 * Run a user-triggered async action so its pending flag always clears and a
 * rejection surfaces as an error toast instead of an unhandled promise rejection.
 * Resolves to false when the action threw, true otherwise.
 */
export async function runPendingAction(
	action: string,
	setPending: ((pending: boolean) => void) | undefined,
	run: () => Promise<unknown>,
): Promise<boolean> {
	setPending?.(true);
	try {
		await run();
		return true;
	} catch (e) {
		pushToast({
			level: "error",
			message: action,
			detail: e instanceof Error ? e.message : String(e),
		});
		return false;
	} finally {
		setPending?.(false);
	}
}
