import {z} from "zod";

import type {ProjectRecord} from "./inventory.js";
import type {Priority} from "./priority.js";

/**
 * Seeds registry priorities from the user's GTD asap ladder: a Workflowy `📌 Tasks (asap)` bucket
 * whose children are ordinal tiers (`1st`, `2nd`, ...). Pure; the CLI reads the export and writes
 * only the proposals the user confirms.
 */

export interface LadderNode {
	name: string;
	completedAt?: string | null | undefined;
	children?: LadderNode[] | undefined;
}

const LadderNodeSchema: z.ZodType<LadderNode> = z.lazy(() =>
	z.object({
		name: z.string(),
		completedAt: z.string().nullish(),
		children: z.array(LadderNodeSchema).optional(),
	}),
);

/** Validates a `node get --depth N --json` export of one asap bucket. */
export function parseAsapLadder(raw: unknown): LadderNode {
	return LadderNodeSchema.parse(raw);
}

export interface PriorityProposal {
	name: string;
	current: Priority | undefined;
	proposed: Priority;
	/** 1-based tier the strongest match sits in. */
	tier: number;
	ladder: string;
	/** The matching node's text with HTML stripped. */
	evidence: string;
}

/** Tiers 1-2 are the day plan (high), 3-4 real intent (medium), the rest the landing zone (low). */
export function tierPriority(tier: number): Priority {
	if (tier <= 2) return "high";
	if (tier <= 4) return "medium";
	return "low";
}

function tierNumber(name: string): number | undefined {
	const match = /^(\d+)(?:st|nd|rd|th)$/.exec(name.trim());
	return match ? Number(match[1]) : undefined;
}

const HTML_ENTITIES: Record<string, string> = {"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"};

function plainText(html: string): string {
	return html
		.replaceAll(/<[^>]*>/g, "")
		.replaceAll(/&(?:amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
		.replaceAll(/\s+/g, " ")
		.trim();
}

function hrefs(html: string): string[] {
	return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function basename(dir: string): string {
	return dir.replace(/\/+$/, "").split("/").pop() ?? dir;
}

/** The names a project may go by on the ladder: its registry name and its directory name. */
function matchKeys(project: ProjectRecord): string[] {
	return [...new Set([project.name, basename(project.dir)])];
}

/**
 * A node names a project when it is exactly the project's name (a project node), tags it as
 * `#name`, links its GitHub repo, or contains a distinctive name (one with `-`, `.` or `/`) as a
 * whole token. A plain word inside a sentence is not enough: "Clean up the sprint" is not `clean`.
 */
function nodeNamesProject(html: string, keys: string[]): boolean {
	const text = plainText(html);
	const lowerText = text.toLowerCase();
	const bareText = lowerText.replace(/^[^\p{L}\p{N}]+/u, "");
	const links = hrefs(html).map((href) => href.toLowerCase());
	return keys.some((key) => {
		const lowerKey = key.toLowerCase();
		if (bareText === lowerKey) return true;
		const bounded = (prefix: string): RegExp =>
			new RegExp(`(?<![\\w-])${prefix}${escapeRegExp(lowerKey)}(?![\\w-])`, "u");
		if (bounded("#").test(lowerText)) return true;
		if (
			links.some((link) => new RegExp(`github\\.com/(?:[^/]+/)?${escapeRegExp(lowerKey)}(?:[/?#]|$)`).test(link))
		) {
			return true;
		}
		return /[-./]/.test(lowerKey) && bounded("").test(lowerText);
	});
}

function* openNodes(node: LadderNode): Generator<LadderNode> {
	if (node.completedAt) return;
	yield node;
	for (const child of node.children ?? []) yield* openNodes(child);
}

/**
 * One proposal per tracked registry project named by an open node on any ladder, from the highest
 * tier it appears in. Projects the ladders never mention get no proposal and stay as they are.
 */
export function proposePriorities(
	ladders: readonly LadderNode[],
	projects: readonly ProjectRecord[],
): PriorityProposal[] {
	const best = new Map<string, PriorityProposal>();
	for (const project of projects) {
		if (project.kind === "skip") continue;
		const keys = matchKeys(project);
		for (const ladder of ladders) {
			for (const tierNode of ladder.children ?? []) {
				const tier = tierNumber(tierNode.name);
				if (tier === undefined || tierNode.completedAt) continue;
				const current = best.get(project.name);
				if (current && current.tier <= tier) continue;
				for (const item of tierNode.children ?? []) {
					const match = [...openNodes(item)].find((node) => nodeNamesProject(node.name, keys));
					if (!match) continue;
					best.set(project.name, {
						name: project.name,
						current: project.priority,
						proposed: tierPriority(tier),
						tier,
						ladder: plainText(ladder.name),
						evidence: plainText(match.name),
					});
					break;
				}
			}
		}
	}
	// tsconfig targets es2022, so Array#toSorted is not in the lib typings.
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
	return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
