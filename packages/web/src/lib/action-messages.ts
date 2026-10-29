import type {ActionResult} from "@wip/shared/schemas.js";
import type {ActionEvent, TaskEvent} from "./server-events-schema.js";
import type {ToastInput, ToastLink} from "./toast-store.js";

/**
 * Plain-language toasts for user actions: what is happening, what happened and
 * where to find it. Internal action labels (createPr, landFastForward) and job
 * kinds never reach the user.
 */

/** What each queued action is doing, by its internal runQueuedAction label. */
const ACTION_PHRASES: Record<string, string> = {
	createPr: "Opening a pull request",
	mergePr: "Merging the pull request",
	forcePush: "Force-pushing",
	landFastForward: "Moving local main",
	pushUpstreamBranch: "Pushing local main",
	rebaseLocal: "Rebasing",
	abortRebase: "Aborting the rebase",
	applyFixes: "Applying the review fixes",
	acceptAutoFix: "Accepting the fix",
	dropAutoFixBranch: "Dropping the fix",
	createBranch: "Creating a branch",
	deleteBranch: "Deleting the branch",
	renameBranch: "Renaming the branch",
	commitWorkingTree: "Committing your changes",
};

/** The job a waiting action is stuck behind, by work-queue job kind. */
const JOB_NAMES: Record<string, string> = {
	test: "a test run",
	rebase: "a rebase",
	push: "a push",
	claude: "a Claude task",
	ladder: "a branch update",
	"merge-status": "a status check",
	"merge-status-deferred": "a status check",
	"escape-hatch": "a More menu recipe",
	"advance-commit": "the ready buffer",
	"branch-name": "the ready buffer",
	"AI conflict rung": "Claude resolving conflicts",
};

const GITHUB_LINK_LABEL = "View on GitHub";
const ACTION_LOG_LINK: ToastLink = {href: "/debug/logs", label: "See the log"};
const TASKS_LINK: ToastLink = {href: "/tasks", label: "See tasks"};

function describeAction(label: string): string {
	return ACTION_PHRASES[label] ?? "Running an action";
}

function describeJob(kind: string | undefined): string {
	return (kind === undefined ? undefined : JOB_NAMES[kind]) ?? "another job";
}

function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The first non-blank line of a failure message, so a stderr dump does not flood the toast. */
function shortReason(message: string | undefined): string | undefined {
	const line = message
		?.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	return line === undefined || line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/** The toast for a queued action waiting for, or refused by, a busy repo; null for running and done. */
export function actionEventToast(event: ActionEvent): ToastInput | null {
	const phrase = describeAction(event.label);
	const subject = event.target === undefined ? `in ${event.project}` : `for ${event.target}`;
	if (event.status === "waiting") {
		return {
			level: "info",
			message: `${phrase} ${subject}…`,
			detail:
				event.waitingFor === undefined
					? undefined
					: `Waiting for ${describeJob(event.waitingFor)} in ${event.project} to finish`,
		};
	}
	if (event.status === "busy") {
		const job = describeJob(event.waitingFor);
		return {
			level: "error",
			message: `Couldn't start ${lowerFirst(phrase)} ${subject}: ${event.project} is busy`,
			detail: `${job.charAt(0).toUpperCase()}${job.slice(1)} is still running; try again shortly`,
		};
	}
	return null;
}

/** The toast for a finished action: its result with a GitHub link, or a short reason and the log. */
export function actionResultToast(action: string, result: ActionResult): ToastInput {
	if (!result.ok) {
		return {
			level: "error",
			message: `${action} failed`,
			detail: shortReason(result.message),
			link: ACTION_LOG_LINK,
		};
	}
	const href = result.prUrl ?? result.compareUrl;
	return {
		level: "success",
		message: result.message,
		...(href === undefined ? {} : {link: {href, label: GITHUB_LINK_LABEL}}),
	};
}

/** The completion toast for a background task (push, rebase, Claude task); null otherwise. */
export function taskEventToast(event: TaskEvent): ToastInput | null {
	if (event.status !== "passed" && event.status !== "failed") return null;
	const logLink: ToastLink = {href: `/log/${event.project}/${event.sha}`, label: "See the log"};
	switch (event.taskType) {
		case "push":
			return event.status === "passed"
				? {
						level: "success",
						message: event.message ?? `Pushed ${event.branch ?? event.shortSha}`,
						...(event.compareUrl === undefined
							? {}
							: {link: {href: event.compareUrl, label: GITHUB_LINK_LABEL}}),
					}
				: {level: "error", message: "Push failed", detail: shortReason(event.message), link: logLink};
		case "rebase":
			return event.status === "passed"
				? {level: "success", message: event.message ?? `Rebased ${event.branch ?? event.shortSha}`}
				: {level: "error", message: "Rebase failed", detail: shortReason(event.message), link: logLink};
		case "claude":
			return event.status === "passed"
				? {level: "success", message: `Finished "${event.subject}"`, link: TASKS_LINK}
				: {
						level: "error",
						message: `Couldn't finish "${event.subject}"`,
						detail: shortReason(event.message),
						link: TASKS_LINK,
					};
		case "test":
		case "ladder":
			break;
	}
	return null;
}
