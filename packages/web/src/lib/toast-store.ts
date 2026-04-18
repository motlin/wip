import type { ActionLogEntry } from "@wip/shared";

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  level: ToastLevel;
  message: string;
  detail?: string;
  /** Milliseconds since epoch when this toast was created. */
  createdAt: number;
}

type Listener = (toasts: readonly Toast[]) => void;

const DEFAULT_TTL_MS = 6000;
const ERROR_TTL_MS = 10000;
const MAX_TOASTS = 8;

let toasts: Toast[] = [];
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let nextId = 0;

function emit(): void {
  const snapshot = toasts;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

function scheduleDismiss(id: string, level: ToastLevel): void {
  // Tests and SSR skip auto-dismiss
  if (typeof window === "undefined") return;
  const ttl = level === "error" ? ERROR_TTL_MS : DEFAULT_TTL_MS;
  const timer = setTimeout(() => {
    dismissToast(id);
  }, ttl);
  timers.set(id, timer);
}

export function pushToast(input: { level: ToastLevel; message: string; detail?: string }): Toast {
  nextId += 1;
  const toast: Toast = {
    id: `toast-${nextId}`,
    level: input.level,
    message: input.message,
    detail: input.detail,
    createdAt: Date.now(),
  };
  toasts = [...toasts, toast];
  if (toasts.length > MAX_TOASTS) {
    const dropped = toasts.slice(0, toasts.length - MAX_TOASTS);
    for (const d of dropped) {
      const t = timers.get(d.id);
      if (t) clearTimeout(t);
      timers.delete(d.id);
    }
    toasts = toasts.slice(-MAX_TOASTS);
  }
  scheduleDismiss(toast.id, toast.level);
  emit();
  return toast;
}

export function dismissToast(id: string): void {
  const existing = toasts.find((t) => t.id === id);
  if (!existing) return;
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function clearToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toasts = [];
  emit();
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Convert a pino log level number into a toast level. Pino uses:
 *   10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
 */
export function levelFromPino(pinoLevel: number): ToastLevel {
  if (pinoLevel >= 50) return "error";
  if (pinoLevel >= 40) return "warning";
  return "info";
}

/**
 * Push each log entry as a toast. Returns the created toast ids so callers
 * can dismiss them later if needed. Entries at the debug/trace level are
 * collapsed into a single summary toast to avoid flooding the UI.
 */
export function toastLogs(entries: readonly ActionLogEntry[]): Toast[] {
  if (entries.length === 0) return [];

  const importantEntries = entries.filter((e) => e.level >= 30);
  const debugEntries = entries.filter((e) => e.level < 30);

  const created: Toast[] = [];
  for (const entry of importantEntries) {
    created.push(
      pushToast({
        level: levelFromPino(entry.level),
        message: entry.msg,
      }),
    );
  }

  if (importantEntries.length === 0 && debugEntries.length > 0) {
    // Show a single summary toast for debug-only actions (typical "clean" flows)
    const latest = debugEntries[debugEntries.length - 1];
    if (latest) {
      created.push(
        pushToast({
          level: "info",
          message: latest.msg,
          detail:
            debugEntries.length > 1
              ? `+${debugEntries.length - 1} more subprocess logs`
              : undefined,
        }),
      );
    }
  }

  return created;
}
