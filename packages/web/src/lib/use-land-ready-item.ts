import {useCallback} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {ReadyToLandItem} from "@wip/shared/ready-to-land.js";
import type {GitChildResult, ProjectInfo} from "@wip/shared/schemas.js";
import {landingAction} from "../components/ready-to-land-section";
import {createPr, landFastForward, mergePr, pushUpstreamBranch, type ProjectChildrenResult} from "./server-fns";
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
					? mergePr({data: {project: item.project, prNumber: action.prNumber}})
					: action.kind === "open-pr"
						? createPr({
								data: {
									project: item.project,
									branch: action.branch,
									title: commit?.subject ?? action.branch,
								},
							})
						: landFastForward({data: {project: item.project, sha: item.sha}});
			void landing.then((result) => {
				pushToast(actionResultToast(LANDING_ACTION_NAMES[action.kind], result));
				const {prNumber, prUrl} = result;
				if (action.kind === "open-pr" && result.ok && prNumber !== undefined) {
					// The row's next step becomes "Merge PR #N" without a refetch.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old?.map((c) => (c.sha === item.sha ? {...c, pushedToRemote: true, prUrl, prNumber} : c)),
					);
				}
				if (action.kind === "fast-forward" && result.ok) {
					// Local main now holds the commit and its stack prefix: the Push row appears without a refetch.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old === undefined ? old : markOnLocalMain(old, item.sha),
					);
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

/** Pushes a project's local main to its remote (the user's separate step after a fast-forward) and toasts the result. */
export function usePushUpstreamBranch(): (project: ProjectInfo) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(project: ProjectInfo) => {
			void pushUpstreamBranch({data: {project: project.name}}).then((result) => {
				pushToast(actionResultToast(`Push ${project.upstreamBranch}`, result));
				if (result.ok) {
					// The remote has them now: the Push row goes away without a refetch.
					queryClient.setQueryData<ProjectChildrenResult>(["children", project.name], (old) =>
						old?.map((c) => (c.onLocalMain === true ? {...c, onLocalMain: undefined} : c)),
					);
				}
				return undefined;
			});
		},
		[queryClient],
	);
}
