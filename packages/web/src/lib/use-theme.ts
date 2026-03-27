import {useState, useEffect, useCallback} from 'react';

type Theme = 'light' | 'dark';

const isServer = typeof window === 'undefined';

function getSystemTheme(): Theme {
	if (isServer) return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme | null {
	if (isServer) return null;
	const stored = localStorage.getItem('theme');
	return stored === 'light' || stored === 'dark' ? stored : null;
}

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle('dark', theme === 'dark');
	document.documentElement.classList.toggle('light', theme === 'light');
}

export function useTheme() {
	const [theme, setThemeState] = useState<Theme>(() => getStoredTheme() ?? getSystemTheme());

	const setTheme = useCallback((t: Theme) => {
		localStorage.setItem('theme', t);
		applyTheme(t);
		setThemeState(t);
	}, []);

	const toggle = useCallback(() => {
		setTheme(theme === 'dark' ? 'light' : 'dark');
	}, [theme, setTheme]);

	useEffect(() => {
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const handler = () => {
			if (!getStoredTheme()) {
				const sys = getSystemTheme();
				applyTheme(sys);
				setThemeState(sys);
			}
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	}, []);

	return {theme, setTheme, toggle};
}
