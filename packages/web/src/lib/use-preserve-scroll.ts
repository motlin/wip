import { useEffect, useRef } from "react";

/**
 * Preserves window scroll position across mobile Chrome tab switches.
 *
 * When Chrome backgrounds a tab on mobile, returning triggers refetchOnWindowFocus
 * which re-renders the page and resets scroll to the top. This hook saves the scroll
 * position when the page becomes hidden and restores it when visible again, retrying
 * across several frames to survive async data re-renders.
 */
export function usePreserveScroll() {
  const savedY = useRef(0);
  const restoreUntil = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const clearTimers = () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };

    const onScroll = () => {
      if (Date.now() < restoreUntil.current) return;
      savedY.current = window.scrollY;
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        savedY.current = window.scrollY;
        return;
      }

      const y = savedY.current;
      if (y <= 0) return;

      clearTimers();

      restoreUntil.current = Date.now() + 2000;
      window.scrollTo(0, y);

      const timers = [50, 150, 300, 600, 1000].map((ms) =>
        setTimeout(() => window.scrollTo(0, y), ms),
      );
      timers.push(
        setTimeout(() => {
          restoreUntil.current = 0;
          clearTimers();
        }, 2000),
      );
      timersRef.current = timers;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearTimers();
    };
  }, []);
}
