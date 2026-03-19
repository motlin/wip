import {Outlet, createRootRoute, HeadContent, Scripts} from '@tanstack/react-router';
import type {ReactNode} from 'react';
import appCss from '../styles/globals.css?url';

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
			<div className="min-h-screen bg-bg-000">
				<Outlet />
			</div>
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
