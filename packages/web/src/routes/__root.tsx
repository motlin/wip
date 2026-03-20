import {Outlet, createRootRoute, HeadContent, Scripts, Link} from '@tanstack/react-router';
import type {ReactNode} from 'react';
import appCss from '../styles/globals.css?url';
import {TestEventsProvider} from '../lib/test-events-context';

export const Route = createRootRoute({
	head: () => ({
		meta: [{charSet: 'utf-8'}, {name: 'viewport', content: 'width=device-width, initial-scale=1'}],
		links: [
			{rel: 'stylesheet', href: appCss},
			{rel: 'preconnect', href: 'https://fonts.googleapis.com'},
			{rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous'},
			{
				rel: 'stylesheet',
				href: 'https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap',
			},
		],
	}),
	component: RootComponent,
	notFoundComponent: NotFound,
});

function RootComponent() {
	return (
		<RootDocument>
			<TestEventsProvider>
				<div className="min-h-screen bg-bg-000">
					<nav className="flex items-center gap-4 border-b border-border-300/50 px-6 py-2 text-sm">
						<Link to="/" className="font-semibold text-text-100 hover:text-text-000">WIP</Link>
						<Link to="/queue" className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium">Queue</Link>
						<Link to="/kanban" className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium">Kanban</Link>
						<Link to="/snoozed" className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium">Snoozed</Link>
						<Link to="/tests" className="text-text-300 hover:text-text-100 [&.active]:text-text-000 [&.active]:font-medium">Tests</Link>
					</nav>
					<Outlet />
				</div>
			</TestEventsProvider>
		</RootDocument>
	);
}

function NotFound() {
	return (
		<div className="p-8">
			<h1 className="text-lg font-semibold">404 &mdash; Not Found</h1>
		</div>
	);
}

const themeScript = `(function(){try{var t=localStorage.getItem('theme');var d=document.documentElement;if(t==='dark')d.classList.add('dark');else if(t==='light')d.classList.add('light');else{d.classList.add(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}}catch(e){}})()`;

function RootDocument({children}: Readonly<{children: ReactNode}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{__html: themeScript}} />
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
