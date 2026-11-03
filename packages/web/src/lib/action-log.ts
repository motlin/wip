import type {ActionLogEntry, ActionResult} from "@wip/shared/schemas.js";
import type {ActionLog} from "./action-log-schema.js";
import {captureActionLogs} from "./queued-action.js";

/** How many failed actions' logs are kept, like latestActionEvent's bound. */
const KEPT_LOGS = 200;
const kept = new Map<string, ActionLog>();

function keep(log: ActionLog): void {
	kept.delete(log.id);
	kept.set(log.id, log);
	while (kept.size > KEPT_LOGS) {
		const oldest = kept.keys().next().value;
		if (oldest === undefined) break;
		kept.delete(oldest);
	}
}

/** A failed action's log by id; null when it succeeded, never ran here, or was evicted. */
export function actionLog(id: string): ActionLog | null {
	return kept.get(id) ?? null;
}

/** The kept failed actions' logs, newest first. */
export function recentActionLogs(): ActionLog[] {
	return [...kept.values()].toReversed();
}

export function resetActionLogs(): void {
	kept.clear();
}

/**
 * Runs a user action, attaching the subprocess/general logs it emitted to its result. A failure
 * (an ok: false result or a throw) keeps its logs and last failing subprocess under `id`, and a
 * failed result carries `actionId` so its "See the log" link opens that action's own log.
 */
export async function loggedAction(
	label: string,
	fn: () => Promise<ActionResult>,
	id: string = crypto.randomUUID(),
): Promise<ActionResult> {
	const {settled, logs, failures} = await captureActionLogs(fn);
	const entries: ActionLogEntry[] = logs.map((e) => ({
		time: e.time,
		level: e.level,
		category: e.category,
		msg: e.msg,
	}));
	const failedCommand = failures.at(-1);
	const record = (message: string): void => {
		keep({id, label, message, ...(failedCommand === undefined ? {} : {failedCommand}), logs: entries});
	};
	if (settled.status === "rejected") {
		const reason: unknown = settled.reason;
		record(reason instanceof Error ? reason.message : String(reason));
		throw reason;
	}
	const result = settled.value;
	if (!result.ok) record(result.message);
	return {
		...result,
		...(result.ok ? {} : {actionId: id}),
		...(entries.length === 0 ? {} : {logs: entries}),
	};
}
