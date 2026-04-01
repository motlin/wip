import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD = 24;

/** Check whether an element is scrolled near the bottom. */
export function isNearBottom(el: HTMLElement, threshold = BOTTOM_THRESHOLD): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
}

/** Scroll an element to the very bottom. */
export function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

/**
 * Hook that auto-tails a scrollable container as new content arrives.
 *
 * Returns a ref to attach to the scrollable container, plus controls for
 * the follow state and a function to scroll the panel into viewport view.
 */
export function useAutoTail(content: string | undefined) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowingState] = useState(true);

  // Track whether the user manually scrolled away from the bottom.
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setIsFollowingState(isNearBottom(el));
  }, []);

  // When following and content changes, scroll to bottom.
  useEffect(() => {
    if (!isFollowing) return;
    const el = containerRef.current;
    if (!el) return;
    scrollToBottom(el);
  }, [content, isFollowing]);

  // Public setter that also scrolls to bottom when re-enabling follow.
  const setFollowing = useCallback((value: boolean) => {
    setIsFollowingState(value);
    if (value) {
      const el = containerRef.current;
      if (el) scrollToBottom(el);
    }
  }, []);

  // Scroll the container element into the viewport.
  const scrollToStart = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return { containerRef, isFollowing, setFollowing, scrollToStart, handleScroll };
}
