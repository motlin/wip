import {effectivePriority, type Priority} from "./priority.js";

/** A registry repo; an unset priority reads as medium. Client-safe: no node builtins. */
export interface ReadySlotRepo {
	name: string;
	priority?: Priority;
}

/** One unit of work (a commit by patch-id, or a todo) and where it stands in the flow. */
export interface ReadySlotItem {
	repo: string;
	id: string;
	/** A per-item override places the item in another tier than its repo's. */
	override?: Priority;
	state: "unready" | "ready" | "landed";
	onHold: boolean;
}

export interface ReadySlotAllocation {
	/** The most ready items this repo may hold in the buffer. */
	slots: number;
	/** The highest tier among this repo's unready work, or null when it has none. */
	tier: Priority | null;
	/** This repo's unready, not-on-hold items in that tier, in input order. */
	pullable: string[];
}

const TIERS: readonly Priority[] = ["high", "medium", "low"];
/** Slots for the first, second, and any later tier that still has unready work. */
const SLOTS_BY_RANK = [2, 1] as const;

/**
 * Lean plan 4.6: each repo in the highest tier that still has unready work gets 2 slots, the
 * next such tier 1, lower tiers 0. Tiers whose work is all ready, landed or on hold drop out, so
 * the next tier moves up. A repo is placed by the highest tier among its own unready items.
 */
export function allocateReadySlots(
	repos: readonly ReadySlotRepo[],
	items: readonly ReadySlotItem[],
): Map<string, ReadySlotAllocation> {
	const repoPriority = new Map(repos.map((r) => [r.name, r.priority]));
	const tierItems = new Map<string, Map<Priority, string[]>>();
	for (const it of items) {
		if (it.state !== "unready" || it.onHold || !repoPriority.has(it.repo)) continue;
		const tier = effectivePriority({repo: repoPriority.get(it.repo), override: it.override});
		const byTier = tierItems.get(it.repo) ?? new Map<Priority, string[]>();
		byTier.set(tier, [...(byTier.get(tier) ?? []), it.id]);
		tierItems.set(it.repo, byTier);
	}

	const repoTier = new Map<string, Priority>();
	for (const [repo, byTier] of tierItems) {
		const top = TIERS.find((t) => byTier.has(t));
		if (top) repoTier.set(repo, top);
	}
	const activeTiers = TIERS.filter((t) => [...repoTier.values()].includes(t));

	const result = new Map<string, ReadySlotAllocation>();
	for (const repo of repos) {
		const tier = repoTier.get(repo.name) ?? null;
		if (tier === null) {
			result.set(repo.name, {slots: 0, tier: null, pullable: []});
			continue;
		}
		const slots = SLOTS_BY_RANK[activeTiers.indexOf(tier)] ?? 0;
		result.set(repo.name, {slots, tier, pullable: tierItems.get(repo.name)?.get(tier) ?? []});
	}
	return result;
}
