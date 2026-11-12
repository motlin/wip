import {useState} from "react";
import {greenPrefix, visiblePushes, type MainPush, type MainPushCommit} from "@wip/shared/main-push.js";
import {stoppedLineRefusal} from "@wip/shared/ready-to-land.js";
import {pushOutcomeKey, type ActionOutcome, type ActionOutcomes} from "../lib/action-outcomes";
import {ActionOutcomeLine, ActionSlot, CANCEL_CLASS} from "./land-control.js";

const CARD_CLASS = "rounded-md border border-border-300/50 bg-bg-000 px-3 py-2 text-xs shadow-sm";

const STATUS_WORDS = {good: "green", bad: "red", unknown: "unknown"} as const;

const commitLabel = (c: MainPushCommit): string => `"${c.subject}" (${c.sha.slice(0, 7)})`;

const statusLabel = (c: MainPushCommit): string => `${commitLabel(c)} ${STATUS_WORDS[c.status]}`;

/**
 * The commits after the green prefix, as one line: how many, how many unknown and red, and the first
 * (never green) by name. The full list sits behind a disclosure so a long tail never floods the row.
 */
function NotPushed({rest}: {rest: readonly MainPushCommit[]}) {
	const [first] = rest;
	const unknown = rest.filter((c) => c.status === "unknown").length;
	const red = rest.filter((c) => c.status === "bad").length;
	return (
		<div data-testid="not-pushed" className="mt-0.5 text-text-500">
			<p>
				Not pushed: {rest.length} {rest.length === 1 ? "commit" : "commits"} ({unknown} unknown, {red} red)
				{first !== undefined && `, first ${statusLabel(first)}`}
			</p>
			<details data-testid="not-pushed-all">
				<summary className="cursor-pointer">Show all {rest.length}</summary>
				<ul className="ml-4 list-disc">
					{rest.map((c) => (
						<li key={c.sha}>{statusLabel(c)}</li>
					))}
				</ul>
			</details>
		</div>
	);
}

/**
 * Push main: local main is ahead of its remote. The card offers one confirmed push of the green
 * prefix (oldest first, by `git test results`), whose confirm names exactly those commits and the
 * sha it pushes; the unknown or red tail is listed as not pushed. A diverged main gets no button.
 */
function PushMainCard({
	push,
	blockedReason,
	onPush,
	outcome,
	onDismissOutcome,
}: {
	push: MainPush;
	/** Why this repo may not push (its upstream is red): shown instead of the button. */
	blockedReason: string | null;
	onPush: (push: MainPush, sha: string) => void;
	outcome: ActionOutcome | undefined;
	onDismissOutcome: (() => void) | undefined;
}) {
	const [confirming, setConfirming] = useState(false);
	const {project, branch, remote} = push;
	const target = `${remote}/${branch}`;
	if (push.diverged) {
		return (
			<div data-testid="push-row" className={`${CARD_CLASS} text-text-300`}>
				{project}: local {branch} has diverged from {target}; rebase first
				<ActionOutcomeLine outcome={outcome} onDismiss={onDismissOutcome} />
			</div>
		);
	}
	const {green, rest} = greenPrefix(push.commits);
	const last = green.at(-1);
	const label = `Push ${green.length} green ${green.length === 1 ? "commit" : "commits"} to ${target}`;
	const confirm =
		confirming && last !== undefined ? (
			<div data-testid="push-confirm" className="flex flex-col gap-2">
				<p>
					{label} in {project}: {green.map(commitLabel).join(", ")}. Pushes {last.sha.slice(0, 7)}
					:refs/heads/{branch}, never forced.
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						disabled={outcome?.status === "running"}
						onClick={() => {
							setConfirming(false);
							onPush(push, last.sha);
						}}
						className="rounded-md bg-status-green px-2.5 py-1 font-medium text-white hover:opacity-90"
					>
						Confirm
					</button>
					<button
						type="button"
						onClick={() => {
							setConfirming(false);
						}}
						className={CANCEL_CLASS}
					>
						Cancel
					</button>
				</div>
			</div>
		) : null;
	return (
		<div data-testid="push-row" className={CARD_CLASS}>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="min-w-0 flex-1 basis-64 text-text-100">
					{project}: {green.length} of {push.commits.length} unpushed commits on {branch} are green
					{push.testing !== undefined && ` · testing ${push.testing.slice(0, 7)}`}
				</span>
				<div className="ml-auto">
					<ActionSlot
						confirm={confirm}
						confirmLabel="Confirm push"
						onCancel={() => {
							setConfirming(false);
						}}
						outcome={outcome}
						onDismissOutcome={onDismissOutcome}
					>
						{blockedReason !== null && <span className="text-text-300">{blockedReason}</span>}
						{blockedReason === null && last !== undefined && (
							<button
								type="button"
								disabled={outcome?.status === "running"}
								aria-expanded={confirming}
								onClick={() => {
									setConfirming(true);
								}}
								className="rounded-md bg-status-green px-2 py-0.5 font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
							>
								{label}
							</button>
						)}
					</ActionSlot>
				</div>
			</div>
			{rest.length > 0 && <NotPushed rest={rest} />}
		</div>
	);
}

/**
 * Push main, one card per project whose local main is ahead of its remote (diverged, green
 * commits to push, or a background test running), first in the Ready to Land column; with
 * `project` set, only that project's. A push whose card left (every green commit pushed) keeps its
 * outcome as a card of its own.
 */
export function PushMainCards({
	pushes,
	project,
	stoppedProjects,
	onPush,
	outcomes,
	onDismissOutcome,
}: {
	pushes: readonly MainPush[];
	project: string | null;
	stoppedProjects: readonly string[];
	onPush: (push: MainPush, sha: string) => void;
	outcomes: ActionOutcomes;
	onDismissOutcome: (key: string) => void;
}) {
	const included = (name: string): boolean => project === null || name === project;
	const shown = visiblePushes(pushes).filter((push) => included(push.project));
	const shownProjects = new Set(shown.map((push) => push.project));
	const left = Object.keys(outcomes)
		.filter((key) => key.startsWith("push:"))
		.map((key) => key.slice("push:".length))
		.filter((name) => !shownProjects.has(name) && included(name));
	const dismiss = (key: string) => () => {
		onDismissOutcome(key);
	};
	return (
		<>
			{shown.map((push) => (
				<PushMainCard
					key={`push:${push.project}`}
					push={push}
					blockedReason={stoppedLineRefusal(push.project, stoppedProjects)}
					onPush={onPush}
					outcome={outcomes[pushOutcomeKey(push.project)]}
					onDismissOutcome={dismiss(pushOutcomeKey(push.project))}
				/>
			))}
			{left.map((name) => (
				<div key={`push:${name}`} data-testid="push-row" className={CARD_CLASS}>
					<ActionOutcomeLine
						outcome={outcomes[pushOutcomeKey(name)]}
						onDismiss={dismiss(pushOutcomeKey(name))}
						prefix={`${name}: `}
					/>
				</div>
			))}
		</>
	);
}
