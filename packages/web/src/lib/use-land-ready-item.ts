import {useCallback, useMemo} from "react";
import {useQueries, useQueryClient} from "@tanstack/react-query";
import type {ReadyToLandItem, ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
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
import {actionResultToast} from "./action-messages";
import {pushToast} from "./toast-store";

const LANDING_ACTION_NAMES = {
	"merge-pr": "Merge PR",
	"open-pr": "Open PR",
	"fast-forward": "Fast-forward main",
} as const;

/** Runs a ready commit's landing action (merge PR, open PR or fast-forward local main) and toasts the result. */
export function useLandReadyItem(): (item: ReadyToLandItem, commit: GitChildResult | undefined) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(item: ReadyToLandItem, commit: GitChildResult | undefined) => {
			const action = landingAction(item, commit);
			if (action === null) return;
			const landing =
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
								},
							})
						: landFastForward({data: {project: item.project, sha: item.sha}});
			void landing.then((result) => {
				pushToast(actionResultToast(LANDING_ACTION_NAMES[action.kind], result));
				const {prNumber, prUrl} = result;
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
 * Pushes the green prefix of a project's local main (up to `sha`) to its remote and toasts the
 * result; the pushed commits leave the Push main row without a refetch.
 */
export function usePushUpstreamBranch(): (push: MainPush, sha: string) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(push: MainPush, sha: string) => {
			void pushUpstreamBranch({data: {project: push.project, sha}}).then((result) => {
				pushToast(actionResultToast(`Push ${push.branch}`, result));
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
