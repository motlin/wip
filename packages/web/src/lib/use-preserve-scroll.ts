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

  useEffect(() => {
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

      restoreUntil.current = Date.now() + 2000;
      window.scrollTo(0, y);

      const timers = [50, 150, 300, 600, 1000].map((ms) =>
        setTimeout(() => window.scrollTo(0, y), ms),
      );
      setTimeout(() => {
        restoreUntil.current = 0;
        for (const t of timers) clearTimeout(t);
      }, 2000);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
