import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "@wip/shared/services/logger-pino.js";
import type { ProjectInfo } from "@wip/shared";

const DEBOUNCE_MS = 500;
const IGNORED_GIT_PATHS = new Set(["objects", "logs", "lfs", "hooks"]);
const IGNORED_FILE_SUFFIXES = [".lock", "COMMIT_EDITMSG", "FETCH_HEAD", "ORIG_HEAD"];

interface WatchedProject {
  name: string;
  watcher: fs.FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
}

const watched = new Map<string, WatchedProject>();
let started = false;
let refresh: ((projectName: string) => Promise<unknown>) | null = null;

function shouldIgnore(relPath: string): boolean {
  const firstSegment = relPath.split(path.sep)[0];
  if (firstSegment && IGNORED_GIT_PATHS.has(firstSegment)) return true;
  return IGNORED_FILE_SUFFIXES.some((suffix) => relPath.endsWith(suffix));
}

function triggerRefresh(project: WatchedProject): void {
  if (project.debounceTimer) clearTimeout(project.debounceTimer);
  project.debounceTimer = setTimeout(() => {
    project.debounceTimer = null;
    refresh?.(project.name).catch((error) => {
      log.general.error({ project: project.name, error }, "git-watcher refresh failed");
    });
  }, DEBOUNCE_MS);
}

function watchProject(p: ProjectInfo): WatchedProject | null {
  const gitDir = path.join(p.dir, ".git");
  if (!fs.existsSync(gitDir)) return null;

  try {
    const project: WatchedProject = {
      name: p.name,
      watcher: fs.watch(gitDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (shouldIgnore(filename)) return;
        triggerRefresh(project);
      }),
      debounceTimer: null,
    };
    project.watcher.on("error", (error) => {
      log.general.error({ project: p.name, error }, "git-watcher fs.watch error");
    });
    return project;
  } catch (error) {
    log.general.error({ project: p.name, error }, "git-watcher failed to watch .git");
    return null;
  }
}

function unwatchProject(project: WatchedProject): void {
  if (project.debounceTimer) clearTimeout(project.debounceTimer);
  project.watcher.close();
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

export async function startGitWatcher(): Promise<void> {
  if (started) return;
  started = true;

  const { getProjects, refreshProjectChildren } = await import("./server-fns.js");
  const { projectEmitter } = await import("./project-events.js");
  refresh = refreshProjectChildren;

  projectEmitter.on("projects", (projects: ProjectInfo[]) => {
    syncWatchers(projects);
  });

  try {
    const projects = await getProjects();
    syncWatchers(projects);
  } catch (error) {
    log.general.error({ error }, "git-watcher initial project load failed");
  }
}
