import {useCallback, useMemo} from "react";
import {useQueries, useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {ActionResult, GitChildResult} from "@wip/shared/schemas.js";
import {afterPush, type MainPush} from "@wip/shared/main-push.js";
import {billingCheckCandidates, landingAction} from "../components/ready-to-land-section";
import {
	createPr,
	getMainPushes,
	landByPushing,
	landFastForward,
	mergePr,
	pushUpstreamBranch,
	type ProjectChildrenResult,
} from "./server-fns";
import {actionsBillingBlockQueryOptions} from "./queries";
import {actionResultOutcome, actionResultToast, runningOutcome} from "./action-messages";
import {landOutcomeKey, pushOutcomeKey, setActionOutcome} from "./action-outcomes";
import {pushToast} from "./toast-store";

const LANDING_ACTION_NAMES = {
	"merge-pr": "Merge PR",
	"open-pr": "Open PR",
	"fast-forward": "Fast-forward main",
} as const;

/** Queued-action labels, for the row's in-progress outcome. */
const LANDING_ACTION_LABELS = {
	"merge-pr": "mergePr",
	"open-pr": "createPr",
	"fast-forward": "landFastForward",
} as const;

/** A server function that threw (network, server error) fails like a refused action, linking the log kept under `actionId`. */
function failedResult(error: unknown, actionId: string | undefined): ActionResult {
	return {
		ok: false,
		message: error instanceof Error ? error.message : String(error),
		...(actionId === undefined ? {} : {actionId}),
	};
}

/**
 * Runs an action whose outcome stays on its row: in progress while it runs, then its result (also
 * echoed as a toast). Resolves with the result, a thrown server function counting as a failure.
 */
async function runWithOutcome(
	queryClient: QueryClient,
	key: string,
	label: string,
	name: string,
	run: () => Promise<ActionResult>,
	actionId?: string,
): Promise<ActionResult> {
	setActionOutcome(queryClient, key, runningOutcome(label));
	const result = await run().catch((error: unknown) => failedResult(error, actionId));
	setActionOutcome(queryClient, key, actionResultOutcome(name, result));
	pushToast(actionResultToast(name, result));
	return result;
}

/**
 * Runs a ready commit's landing action (merge PR, open PR or fast-forward local main), keeping its
 * outcome on the row and toasting the result. Open PR opens a wip tab following the action (its
 * progress, then the new PR or the reason it failed).
 */
export function useLandReadyItem(): (item: ReadyToLandItem, commit: GitChildResult | undefined) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(item: ReadyToLandItem, commit: GitChildResult | undefined) => {
			const action = landingAction(item, commit);
			if (action === null) return;
			// Opened inside the confirm click so popup blockers allow it. It shows the action's progress
			// from the server under this id and goes to the PR once it exists; a failure stays on it.
			const actionId = action.kind === "open-pr" ? crypto.randomUUID() : undefined;
			const tab = actionId === undefined ? null : window.open(`/opening/${actionId}`, "_blank");
			if (tab !== null) tab.opener = null;
			const landing = async () =>
				action.kind === "merge-pr"
					? mergePr({data: {project: item.project, prNumber: action.prNumber, autoMerge: action.autoMerge}})
					: action.kind === "open-pr"
						? createPr({
								data: {
									project: item.project,
									branch: action.branch,
									title: commit?.subject ?? action.branch,
									// Opened ready for review; the server turns on auto-merge only where the repo allows it.
									autoMerge: true,
									...(actionId === undefined ? {} : {actionId}),
									// The buffer's draft PR for this branch: marked ready, not opened again.
									...(action.draftPrNumber === undefined
										? {}
										: {draftPrNumber: action.draftPrNumber}),
								},
							})
						: landFastForward({data: {project: item.project, sha: item.sha}});
			void runWithOutcome(
				queryClient,
				landOutcomeKey(item.project, item.sha),
				LANDING_ACTION_LABELS[action.kind],
				LANDING_ACTION_NAMES[action.kind],
				landing,
				actionId,
			).then((result) => {
				const {prNumber, prUrl} = result;
				if (tab !== null) {
					// The tab's own poll gets there too; this also covers a request that threw before the
					// server recorded the action. A failure stays visible in the tab, never closed. Without a
					// PR (the token couldn't open one) it goes to GitHub's new-PR page for the pushed branch.
					const githubUrl = prUrl ?? result.compareUrl;
					tab.location.href =
						result.ok && githubUrl !== undefined
							? githubUrl
							: `/opening/${actionId}?failed=${encodeURIComponent(result.message)}`;
				}
				if (action.kind === "open-pr" && result.ok && prNumber !== undefined) {
					// Its checks have not reported yet: without a refetch the row leaves Ready to land (or
					// shows as merging when auto-merge is on), and returns as Merge PR once they pass.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old?.map((c) =>
							c.sha === item.sha
								? {
										...c,
										pushedToRemote: true,
										prUrl,
										prNumber,
										checkStatus: "pending",
										mergeStateStatus: undefined,
										autoMerge: result.autoMerge,
									}
								: c,
						),
					);
				}
				if (action.kind === "merge-pr" && result.ok && result.autoMerge === true) {
					// The row shows as merging until GitHub merges it.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old?.map((c) => (c.sha === item.sha ? {...c, autoMerge: true} : c)),
					);
				}
				if (action.kind === "fast-forward" && result.ok) {
					// Local main now holds the commit and its stack prefix: the buffer leaves them alone.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old === undefined ? old : markOnLocalMain(old, item.sha),
					);
					// Its Push main row is written straight into the cache, not refetched.
					void getMainPushes({data: {project: item.project}}).then((fresh) => {
						queryClient.setQueryData<MainPush[]>(["mainPushes"], (old) => [
							...(old ?? []).filter((p) => p.project !== item.project),
							...fresh,
						]);
						return undefined;
					});
				}
				return undefined;
			});
		},
		[queryClient],
	);
}

/** Flags `sha` and the children it stacks on as fast-forwarded onto local main. */
function markOnLocalMain(children: ProjectChildrenResult, sha: string): ProjectChildrenResult {
	const bySha = new Map(children.map((c) => [c.sha, c]));
	const chain = new Set<string>();
	for (let at = bySha.get(sha); at !== undefined && !chain.has(at.sha); at = bySha.get(at.parentSha ?? "")) {
		chain.add(at.sha);
	}
	return children.map((c) => (chain.has(c.sha) ? {...c, onLocalMain: true} : c));
}

/**
 * Pushes the green prefix of a project's local main (up to `sha`) to its remote, keeping the outcome
 * on its Push main row and toasting the result; the pushed commits leave the row without a refetch.
 */
export function usePushUpstreamBranch(): (push: MainPush, sha: string) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(push: MainPush, sha: string) => {
			void runWithOutcome(
				queryClient,
				pushOutcomeKey(push.project),
				"pushUpstreamBranch",
				`Push ${push.branch}`,
				async () => pushUpstreamBranch({data: {project: push.project, sha}}),
			).then((result) => {
				if (result.ok) {
					const pushed = new Set(
						push.commits.slice(0, push.commits.findIndex((c) => c.sha === sha) + 1).map((c) => c.sha),
					);
					queryClient.setQueryData<MainPush[]>(["mainPushes"], (old) =>
						old === undefined ? old : afterPush(old, push.project, sha),
					);
					queryClient.setQueryData<ProjectChildrenResult>(["children", push.project], (old) =>
						old?.map((c) => (pushed.has(c.sha) ? {...c, onLocalMain: undefined} : c)),
					);
				}
				return undefined;
			});
		},
		[queryClient],
	);
}

/** `project:sha` of the ready rows whose PR checks can't run because Actions are unavailable for billing. */
export function useActionsBlocked(
	state: ReadyToLandState | null | undefined,
	commits: readonly GitChildResult[],
): ReadonlySet<string> {
	const candidates = useMemo(() => billingCheckCandidates(state, commits), [state, commits]);
	const results = useQueries({
		queries: candidates.map((item) => actionsBillingBlockQueryOptions(item.project, item.sha)),
	});
	const blocked = candidates.filter((_, i) => results[i]?.data === true).map((item) => `${item.project}:${item.sha}`);
	const joined = blocked.join("\n");
	return useMemo(() => new Set(joined === "" ? [] : joined.split("\n")), [joined]);
}

/** Configures a repo to land by pushing directly (after the row's confirm) and toasts the result. */
export function useLandByPushing(): (project: string) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(project: string) => {
			void landByPushing({data: {project}}).then((result) => {
				pushToast(actionResultToast("Land by pushing", result));
				if (result.ok) {
					// The repo's ready rows offer Fast-forward main now, without waiting for the buffer.
					queryClient.setQueryData<ReadyToLandState | null>(["readyToLand"], (old) =>
						old
							? {
									...old,
									ready: old.ready.map((item) =>
										item.project === project ? {...item, landing: "fast-forward"} : item,
									),
								}
							: old,
					);
				}
				return undefined;
			});
		},
		[queryClient],
	);
}
