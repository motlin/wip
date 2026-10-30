import * as events from "node:events";
import type {ActionEvent} from "./server-events-schema.js";

export type {ActionEvent};

export const actionEmitter = new events.EventEmitter();
actionEmitter.setMaxListeners(100);

/** How many actions' latest events are kept for tabs that load after the events went out. */
const KEPT_ACTIONS = 200;
const latest = new Map<string, ActionEvent>();

/** Emits an action event and keeps it as the action's latest status. */
export function emitAction(event: ActionEvent): void {
	latest.delete(event.id);
	latest.set(event.id, event);
	while (latest.size > KEPT_ACTIONS) {
		const oldest = latest.keys().next().value;
		if (oldest === undefined) break;
		latest.delete(oldest);
	}
	actionEmitter.emit("action", event);
}

/** The latest event of an action, so a tab opened for it shows its progress or result; null if unknown. */
export function latestActionEvent(id: string): ActionEvent | null {
	return latest.get(id) ?? null;
}
