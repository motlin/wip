import {useCallback} from "react";
import {useQueryClient} from "@tanstack/react-query";
import type {ReadyToLandItem} from "@wip/shared/ready-to-land.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {landingAction} from "../components/ready-to-land-section";
import {createPr, landFastForward, mergePr, type ProjectChildrenResult} from "./server-fns";
import {pushToast} from "./toast-store";

/** Runs a ready commit's landing action (merge PR, open PR or fast-forward) and toasts the result. */
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
				pushToast({level: result.ok ? "success" : "error", message: result.message});
				const prNumber = result.compareUrl?.match(/\/pull\/(\d+)/)?.[1];
				if (action.kind === "open-pr" && result.ok && prNumber !== undefined) {
					// The row's next step becomes "Merge PR #N" without a refetch.
					queryClient.setQueryData<ProjectChildrenResult>(["children", item.project], (old) =>
						old?.map((c) =>
							c.sha === item.sha
								? {...c, pushedToRemote: true, prUrl: result.compareUrl, prNumber: Number(prNumber)}
								: c,
						),
					);
				}
				return undefined;
			});
		},
		[queryClient],
	);
}
