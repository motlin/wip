import {useCallback} from "react";
import {skipToken, useQuery, useQueryClient, type QueryClient} from "@tanstack/react-query";
import type {ReadyToLandState} from "@wip/shared/ready-to-land.js";
import type {ToastLink} from "./toast-store.js";

/**
 * The latest outcome of a row's action, kept on the row until its next action replaces it: in
 * progress, done (with where to find the result), or failed (with a short reason and the log).
 * Toasts only echo it; a link or an error never lives only in a toast that vanishes.
 */
export type ActionOutcome =
	| {status: "running"; message: string}
	| {status: "success"; message: string; link?: ToastLink}
	| {status: "failure"; message: string; detail?: string; link: ToastLink};

/** Outcomes by row key: {@link landOutcomeKey} for a ready row, {@link pushOutcomeKey} for a Push main row. */
export type ActionOutcomes = Readonly<Record<string, ActionOutcome>>;

export const ACTION_OUTCOMES_KEY = ["actionOutcomes"] as const;

const NO_OUTCOMES: ActionOutcomes = {};

export const landOutcomeKey = (project: string, sha: string): string => `land:${project}:${sha}`;

export const pushOutcomeKey = (project: string): string => `push:${project}`;

/** Writes (or, with undefined, clears) one row's outcome into the cache. */
export function setActionOutcome(queryClient: QueryClient, key: string, outcome: ActionOutcome | undefined): void {
	queryClient.setQueryData<ActionOutcomes>(ACTION_OUTCOMES_KEY, (old = NO_OUTCOMES) => {
		if (outcome !== undefined) return {...old, [key]: outcome};
		if (!(key in old)) return old;
		const {[key]: _cleared, ...rest} = old;
		return rest;
	});
}

/** Drops the landing outcomes of rows that left the ready buffer; Push main outcomes stay until replaced. */
export function pruneLandOutcomes(outcomes: ActionOutcomes, state: ReadyToLandState | null): ActionOutcomes {
	const live = new Set(
		[
			...(state?.ready ?? []),
			...(state?.awaitingChecks ?? []),
			...(state?.checksFailed ?? []),
			...(state?.inFlight ?? []),
		].map((item) => landOutcomeKey(item.project, item.sha)),
	);
	const kept = Object.entries(outcomes).filter(([key]) => !key.startsWith("land:") || live.has(key));
	return kept.length === Object.keys(outcomes).length ? outcomes : Object.fromEntries(kept);
}

/** Every row's latest outcome, read from the cache the action hooks write. */
export function useActionOutcomes(): ActionOutcomes {
	const {data} = useQuery<ActionOutcomes>({
		queryKey: ACTION_OUTCOMES_KEY,
		queryFn: skipToken,
		staleTime: Infinity,
		gcTime: Infinity,
	});
	return data ?? NO_OUTCOMES;
}

/** Clears one row's outcome when the user dismisses it. */
export function useDismissActionOutcome(): (key: string) => void {
	const queryClient = useQueryClient();
	return useCallback(
		(key: string) => {
			setActionOutcome(queryClient, key, undefined);
		},
		[queryClient],
	);
}
