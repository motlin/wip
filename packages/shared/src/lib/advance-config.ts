import * as fs from "node:fs";
import * as path from "node:path";

import {getAdvanceConfig} from "./db.js";

/**
 * Per-repo parallelism for the advance loop. Some test suites collide when run
 * concurrently (shared ports, fixtures), so concurrency is configurable per repo.
 *
 * Precedence: DB override (web-editable) > `.envrc` (WIP_ADVANCE_CONCURRENCY) >
 * default 1 (serial), until a repo is proven safe to parallelize.
 */

const DEFAULT_CONCURRENCY = 1;

const ENVRC_RE = /^(?:export\s+)?WIP_ADVANCE_CONCURRENCY=(\S+)/m;

/** Read WIP_ADVANCE_CONCURRENCY from a repo's `.envrc`, or null if absent/invalid. */
export function parseAdvanceConcurrency(dir: string): number | null {
	const envrcPath = path.join(dir, ".envrc");
	if (!fs.existsSync(envrcPath)) return null;
	const match = fs.readFileSync(envrcPath, "utf-8").match(ENVRC_RE);
	if (!match) return null;
	const value = Number.parseInt(match[1] ?? "", 10);
	return Number.isInteger(value) && value >= 1 ? value : null;
}

export function resolveAdvanceConcurrency(project: string, dir: string): number {
	return getAdvanceConfig(project) ?? parseAdvanceConcurrency(dir) ?? DEFAULT_CONCURRENCY;
}

function patternMatches(name: string, pattern: string): boolean {
	if (pattern.includes("*")) {
		const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
		return re.test(name);
	}
	return name.includes(pattern);
}

/**
 * Project selection for an advance run. A name is included when no include
 * patterns are given or at least one matches, and excluded when any exclude
 * pattern matches (exclude wins). Patterns are substrings, or globs when they
 * contain `*`.
 */
export function matchesFilters(name: string, include: string[], exclude: string[]): boolean {
	if (exclude.some((pattern) => patternMatches(name, pattern))) return false;
	if (include.length === 0) return true;
	return include.some((pattern) => patternMatches(name, pattern));
}
