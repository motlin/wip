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

interface WatchedProject {
	name: string;
	watchers: fs.FSWatcher[];
	debounceTimer: NodeJS.Timeout | null;
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
		// Checked at fire time, not event time: our own refresh work (fetch,
		// prune) writes into .git and would otherwise loop the watcher forever.
		if (isWatcherSuppressed(project.name)) return;
		refresh?.(project.name).catch((error) => {
			log.general.error({project: project.name, error}, "git-watcher refresh failed");
		});
	}, DEBOUNCE_MS);
}

function watchProject(p: ProjectInfo): WatchedProject | null {
	const gitDir = path.join(p.dir, ".git");
	if (!fs.existsSync(gitDir)) return null;

	// Watch only ref state, never the whole .git dir: a recursive watch on
	// sixty repos (objects/, index churn) drove fseventsd to a full core all
	// by itself. HEAD + packed-refs live in .git (non-recursive); branch tips
	// live under .git/refs (small, safe to watch recursively).
	try {
		const project: WatchedProject = {
			name: p.name,
			watchers: [],
			debounceTimer: null,
		};
		const onChange = (_event: string, filename: string | Buffer | null) => {
			if (!filename) return;
			if (shouldIgnore(String(filename))) return;
			triggerRefresh(project);
		};

		project.watchers.push(fs.watch(gitDir, {recursive: false}, onChange));
		const refsDir = path.join(gitDir, "refs");
		if (fs.existsSync(refsDir)) {
			project.watchers.push(fs.watch(refsDir, {recursive: true}, onChange));
		}
		for (const watcher of project.watchers) {
			watcher.on("error", (error) => {
				log.general.error({project: p.name, error}, "git-watcher fs.watch error");
			});
		}
		return project;
	} catch (error) {
		log.general.error({project: p.name, error}, "git-watcher failed to watch .git");
		return null;
	}
}

function unwatchProject(project: WatchedProject): void {
	if (project.debounceTimer) clearTimeout(project.debounceTimer);
	for (const watcher of project.watchers) {
		watcher.close();
	}
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
		const project = watchProject(p);
		if (project) watched.set(p.name, project);
	}
}

/**
 * The caller supplies onRepoChange (background-refresh passes its force-refresh
 * enqueue) so this module never imports background-refresh back — that import
 * cycle broke tree-shaking and risked initialization-order failures.
 */
export async function startGitWatcher(onRepoChange: (projectName: string) => void): Promise<void> {
	if (started) return;
	started = true;

	const {getProjects} = await import("./server-fns.js");
	const {projectEmitter} = await import("./project-events.js");
	refresh = async (projectName: string) => {
		onRepoChange(projectName);
	};

	projectEmitter.on("projects", (projects: ProjectInfo[]) => {
		syncWatchers(projects);
	});

	try {
		const projects = await getProjects();
		syncWatchers(projects);
	} catch (error) {
		log.general.error({error}, "git-watcher initial project load failed");
	}
}
