import * as fs from "node:fs";
import * as path from "node:path";
import {log} from "@wip/shared/services/logger-pino.js";
import type {ProjectInfo} from "@wip/shared";
import {isWatcherSuppressed} from "./watch-suppression.js";

const DEBOUNCE_MS = 500;
// `index` matters: git rewrites it on nearly every read-ish operation
// (status, diff), so reacting to it loops the watcher against our own
// refreshes and anything else touching the repo.
const IGNORED_FILE_SUFFIXES = [".lock", "COMMIT_EDITMSG", "FETCH_HEAD", "ORIG_HEAD", "index"];

// A dead watcher is re-opened after RETRY_BASE_MS, doubling per consecutive
// failure up to RETRY_MAX_MS. When macOS FSEvents is exhausted every fs.watch
// dies with EMFILE right after it opens; re-watching at once made a tight loop
// across all repos that kept fseventsd saturated for the whole machine. While a
// project waits, the periodic background sweep still refreshes it.
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5 * 60_000;

interface WatchedProject {
	name: string;
	watchers: fs.FSWatcher[];
	debounceTimer: NodeJS.Timeout | null;
	retryTimer: NodeJS.Timeout | null;
	/** Consecutive failed watch rounds; reset once a change event arrives. */
	failures: number;
}

const watched = new Map<string, WatchedProject>();
let started = false;
let refresh: ((projectName: string) => Promise<unknown>) | null = null;

function shouldIgnore(relPath: string): boolean {
	return IGNORED_FILE_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

function triggerRefresh(project: WatchedProject): void {
	if (project.debounceTimer) clearTimeout(project.debounceTimer);
	project.debounceTimer = setTimeout(() => {
		project.debounceTimer = null;
		// Checked at fire time, not event time. While our own refresh work
		// (fetch, prune) runs, wait for it to finish rather than drop the fire:
		// a real ref change can land in that window too, and the watch gate
		// tells it apart from our own writes by comparing ref state.
		if (isWatcherSuppressed(project.name)) {
			triggerRefresh(project);
			return;
		}
		refresh?.(project.name).catch((error: unknown) => {
			log.general.error({project: project.name, error}, "git-watcher refresh failed");
		});
	}, DEBOUNCE_MS);
}

function closeWatchers(project: WatchedProject): void {
	for (const watcher of project.watchers) {
		watcher.close();
	}
	project.watchers = [];
}

/**
 * Close the project's watchers and open them again after a backoff. Only the
 * first failure of a round counts: the round's other watcher erroring too, or
 * an error while a retry is already pending, changes nothing.
 */
function failWatch(p: ProjectInfo, project: WatchedProject, error: unknown): void {
	if (watched.get(p.name) !== project || project.retryTimer) return;
	closeWatchers(project);
	const retryInMs = Math.min(RETRY_BASE_MS * 2 ** project.failures, RETRY_MAX_MS);
	project.failures++;
	log.general.error(
		{project: p.name, error, failures: project.failures, retryInMs},
		"git-watcher fs.watch failed; re-watching after backoff",
	);
	project.retryTimer = setTimeout(() => {
		project.retryTimer = null;
		if (watched.get(p.name) === project) openWatchers(p, project);
	}, retryInMs);
}

function openWatchers(p: ProjectInfo, project: WatchedProject): void {
	const gitDir = path.join(p.dir, ".git");
	const onChange = (_event: string, filename: string | Buffer | null) => {
		if (!filename) return;
		if (shouldIgnore(String(filename))) return;
		project.failures = 0;
		triggerRefresh(project);
	};

	// Watch only ref state, never the whole .git dir: a recursive watch on
	// sixty repos (objects/, index churn) drove fseventsd to a full core all
	// by itself. HEAD + packed-refs live in .git (non-recursive); branch tips
	// live under .git/refs (small, safe to watch recursively).
	try {
		project.watchers.push(fs.watch(gitDir, {recursive: false}, onChange));
		const refsDir = path.join(gitDir, "refs");
		if (fs.existsSync(refsDir)) {
			project.watchers.push(fs.watch(refsDir, {recursive: true}, onChange));
		} else {
			log.general.warn(
				{project: p.name, dir: p.dir},
				"git-watcher not watching branch refs: no .git/refs directory",
			);
		}
	} catch (error) {
		failWatch(p, project, error);
		return;
	}
	for (const watcher of project.watchers) {
		watcher.on("error", (error) => {
			failWatch(p, project, error);
		});
	}
}

function unwatchProject(project: WatchedProject): void {
	if (project.debounceTimer) clearTimeout(project.debounceTimer);
	if (project.retryTimer) clearTimeout(project.retryTimer);
	closeWatchers(project);
}

function syncWatchers(projects: ProjectInfo[]): void {
	const next = new Set(projects.map((p) => p.name));

	for (const [name, project] of watched) {
		if (!next.has(name)) {
			unwatchProject(project);
			watched.delete(name);
		}
	}

	for (const p of projects) {
		if (watched.has(p.name)) continue;
		if (!fs.existsSync(path.join(p.dir, ".git"))) {
			log.general.warn({project: p.name, dir: p.dir}, "git-watcher not watching project: no .git directory");
			continue;
		}
		const project: WatchedProject = {
			name: p.name,
			watchers: [],
			debounceTimer: null,
			retryTimer: null,
			failures: 0,
		};
		watched.set(p.name, project);
		openWatchers(p, project);
	}
	log.general.info({watching: watched.size, projects: projects.length}, "git-watcher projects watched");
}

/**
 * The caller supplies onRepoChange (background-refresh passes its force-refresh
 * enqueue) so this module never imports background-refresh back — that import
 * cycle broke tree-shaking and risked initialization-order failures.
 */
export async function startGitWatcher(onRepoChange: (projectName: string) => void): Promise<void> {
	if (started) return;
	started = true;

	const {listProjects} = await import("./server-fns.js");
	const {projectEmitter} = await import("./project-events.js");
	refresh = async (projectName: string) => {
		onRepoChange(projectName);
		return Promise.resolve();
	};

	projectEmitter.on("projects", (projects: ProjectInfo[]) => {
		syncWatchers(projects);
	});

	try {
		const projects = await listProjects();
		syncWatchers(projects);
	} catch (error) {
		log.general.error({error}, "git-watcher initial project load failed");
	}
}
