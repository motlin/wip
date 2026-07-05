import {useState, useEffect, useCallback} from "react";

type Theme = "light" | "dark";

const isServer = typeof window === "undefined";

function getSystemTheme(): Theme {
	if (isServer) return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme(): Theme | null {
	if (isServer) return null;
	const stored = localStorage.getItem("theme");
	return stored === "light" || stored === "dark" ? stored : null;
}

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
	document.documentElement.classList.toggle("light", theme === "light");
}

export function useTheme() {
	// Always start from the server default. Reading localStorage in the
	// initializer makes the hydration render differ from the SSR HTML, and the
	// resulting mismatch throws away the whole server-rendered tree. The
	// effects below sync to the real preference right after hydration.
	const [theme, setThemeState] = useState<Theme>("light");

	const setTheme = useCallback((t: Theme) => {
		localStorage.setItem("theme", t);
		applyTheme(t);
		setThemeState(t);
	}, []);

	const toggle = useCallback(() => {
		setTheme(theme === "dark" ? "light" : "dark");
	}, [theme, setTheme]);

	// Sync React state with the actual theme after hydration.
	// During SSR, useState initializes to 'light' (server default).
	// React reuses that value during hydration, so we read localStorage
	// in an effect to pick up the real persisted preference.
	useEffect(() => {
		const stored = getStoredTheme();
		const resolved = stored ?? getSystemTheme();
		applyTheme(resolved);
		setThemeState(resolved);
	}, []);

	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = () => {
			if (!getStoredTheme()) {
				const sys = getSystemTheme();
				applyTheme(sys);
				setThemeState(sys);
			}
		};
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, []);

	return {theme, setTheme, toggle};
}
