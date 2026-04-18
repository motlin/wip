import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X, AlertTriangle } from "lucide-react";
import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type Toast,
  type ToastLevel,
} from "../lib/toast-store";

const LEVEL_STYLES: Record<ToastLevel, string> = {
  info: "border-blue-500/40 bg-blue-50 text-blue-900 dark:bg-blue-950/60 dark:text-blue-100",
  success:
    "border-green-500/40 bg-green-50 text-green-900 dark:bg-green-950/60 dark:text-green-100",
  warning:
    "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
  error: "border-red-500/40 bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-100",
};

const LEVEL_ICON: Record<ToastLevel, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function Toaster() {
  const [toasts, setToasts] = useState<readonly Toast[]>(() => getToasts());

  useEffect(() => {
    const unsubscribe = subscribeToasts((next) => {
      setToasts(next);
    });
    return unsubscribe;
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const Icon = LEVEL_ICON[toast.level];
        return (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg ${LEVEL_STYLES[toast.level]}`}
          >
            <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium">{toast.message}</p>
              {toast.detail && <p className="mt-0.5 break-words opacity-80">{toast.detail}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              className="ml-1 rounded p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
