import {z} from "zod";
import {ActionLogEntrySchema} from "@wip/shared/schemas.js";

/** A failed user action's own log: its reason, the last subprocess that failed, and the entries it emitted. */
const ActionLogSchema = z.object({
	id: z.string(),
	/** The internal action name (createPr, rebaseLocal); the page turns it into words. */
	label: z.string(),
	message: z.string(),
	failedCommand: z.object({command: z.string(), exitCode: z.number(), stderr: z.string()}).optional(),
	logs: z.array(ActionLogEntrySchema),
});
export type ActionLog = z.infer<typeof ActionLogSchema>;

/** Where a failed action's "See the log" link goes: that action's log, or the recent failures when its id is unknown. */
export function actionLogHref(actionId: string | undefined): string {
	return actionId === undefined ? "/action-log" : `/action-log/${encodeURIComponent(actionId)}`;
}
