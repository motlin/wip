import { writeLogEntry } from "./logger.js";
import type { StderrLog } from "./logger-pino-stderr.js";

// Browser-safe logging facade. This module is transitively imported by many
// @wip/shared modules (db, git, github-*) which are in turn pulled into the web
// client bundle. It must therefore have NO static node imports — Vite externalizes
// node builtins for the browser and throws on the import binding, which previously
// crashed client hydration on every route.

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

type LevelName = keyof typeof LEVELS;
type Fields = Record<string, unknown>;

interface CategoryLogger {
  trace(obj: Fields | string, msg?: string): void;
  debug(obj: Fields | string, msg?: string): void;
  info(obj: Fields | string, msg?: string): void;
  warn(obj: Fields | string, msg?: string): void;
  error(obj: Fields | string, msg?: string): void;
  fatal(obj: Fields | string, msg?: string): void;
}

type Category = "subprocess" | "progress" | "general";

function isLoggingEnabled(): boolean {
  return typeof process !== "undefined" && process.env?.["WIP_SUBPROCESS_LOGGING"] === "true";
}

// Pino pretty-printer for stderr, loaded lazily on the server only. The dynamic
// import keeps node-only code out of the client module graph; in the browser the
// import would reject (and is gated behind isLoggingEnabled anyway), so stderr
// output is simply skipped while the in-memory buffer is still fed below.
let stderrLog: StderrLog | undefined;
let stderrLoading = false;
function ensureStderrLog(): void {
  if (stderrLog || stderrLoading || !isLoggingEnabled()) return;
  stderrLoading = true;
  import("./logger-pino-stderr.js")
    .then((m) => {
      stderrLog = m.createStderrLog();
    })
    .catch(() => {});
}

function emit(category: Category, level: LevelName, arg1: Fields | string, arg2?: string): void {
  if (!isLoggingEnabled()) return;

  const fields = typeof arg1 === "string" ? {} : arg1;
  const msg = typeof arg1 === "string" ? arg1 : (arg2 ?? "");

  writeLogEntry({ time: Date.now(), level: LEVELS[level], category, msg, ...fields });

  ensureStderrLog();
  stderrLog?.[category][level](fields, msg);
}

function makeCategoryLogger(category: Category): CategoryLogger {
  const at =
    (level: LevelName) =>
    (obj: Fields | string, msg?: string): void =>
      emit(category, level, obj, msg);
  return {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
  };
}

export const log = {
  subprocess: makeCategoryLogger("subprocess"),
  progress: makeCategoryLogger("progress"),
  general: makeCategoryLogger("general"),
};
