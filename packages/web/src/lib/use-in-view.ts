import {useEffect, useRef, useState} from "react";

/**
 * Hook that observes an element with `IntersectionObserver` and flags it as
 * "in view" once it intersects the viewport (plus optional `rootMargin`).
 *
 * Once flagged, the value stays `true` so expensive work triggered by
 * visibility is only run once per mount.
 *
 * If `IntersectionObserver` is unavailable (older browsers, SSR), returns
 * `true` immediately so consumers fall back to eager rendering.
 */
export function useInView<T extends Element = Element>({rootMargin}: {rootMargin?: string} = {}) {
	const ref = useRef<T | null>(null);
	const [inView, setInView] = useState(false);

	useEffect(() => {
		if (inView) return undefined;
		const el = ref.current;
		if (!el) return undefined;
		if (typeof IntersectionObserver === "undefined") {
			// oxlint-disable-next-line react/set-state-in-effect -- the fallback must flip after mount to keep hydration deterministic
			setInView(true);
			return undefined;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setInView(true);
						observer.disconnect();
						return;
					}
				}
			},
			{rootMargin},
		);
		observer.observe(el);
		return () => {
			observer.disconnect();
		};
	}, [inView, rootMargin]);

	return {ref, inView};
}
