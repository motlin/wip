/**
 * Cross-process per-repo lock. The work queue's `repo:<project>` resource only
 * excludes jobs inside one process; the CLI and the web server are separate
 * processes that can touch the same repo at once. A lock file per repo, created
 * exclusively and holding the owner pid, extends that exclusion across them.
 * A lock whose pid is dead is reclaimed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {getCacheDir} from "./config.js";
import type {ResourceLock} from "./work-queue.js";

const REPO_RESOURCE_PREFIX = "repo:";
const DEFAULT_POLL_MS = 100;

export interface RepoResourceLockOptions {
	/** Directory holding lock files; defaults to <cache dir>/locks. */
	lockDir?: string;
	pollMs?: number;
}

function errnoCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return errnoCode(error) === "EPERM";
	}
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function readOwner(file: string): number | undefined {
	try {
		const pid = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
		return Number.isFinite(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

function tryCreate(file: string): boolean {
	try {
		fs.writeFileSync(file, String(process.pid), {flag: "wx"});
		return true;
	} catch (error) {
		if (errnoCode(error) === "EEXIST") return false;
		throw error;
	}
}

/** Remove a lock whose owner is dead. Renames first so two reclaimers cannot both delete a fresh lock. */
function reclaimIfStale(file: string): void {
	const owner = readOwner(file);
	if (owner !== undefined && isPidAlive(owner)) return;
	const aside = `${file}.stale-${process.pid}-${Date.now()}`;
	try {
		fs.renameSync(file, aside);
	} catch {
		return;
	}
	const moved = readOwner(aside);
	if (moved !== undefined && moved !== owner && isPidAlive(moved)) {
		// We displaced a live lock created after our check; put it back unless someone re-took the slot.
		try {
			fs.linkSync(aside, file);
		} catch {
			// Another holder already exists; nothing safe to restore.
		}
	}
	fs.rmSync(aside, {force: true});
}

export function createRepoResourceLock(options: RepoResourceLockOptions = {}): ResourceLock {
	const lockDir = options.lockDir ?? path.join(getCacheDir(), "locks");
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

	return async (resource, signal) => {
		if (!resource.startsWith(REPO_RESOURCE_PREFIX)) return () => {};
		fs.mkdirSync(lockDir, {recursive: true});
		const name = resource.slice(REPO_RESOURCE_PREFIX.length).replaceAll(/[^\w.-]/g, "_");
		const file = path.join(lockDir, `repo_${name}.lock`);

		/* oxlint-disable no-await-in-loop -- polling for the lock is inherently sequential */
		while (!tryCreate(file)) {
			if (signal.aborted) throw new Error(`Aborted waiting for ${resource} lock`);
			reclaimIfStale(file);
			if (tryCreate(file)) break;
			await sleep(pollMs);
		}
		/* oxlint-enable no-await-in-loop */

		return () => {
			if (readOwner(file) === process.pid) fs.rmSync(file, {force: true});
		};
	};
}
