import {defineConfig} from 'vite';
import {tanstackStart} from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		port: 3456,
		host: true,
		watch: {ignored: ['**/routeTree.gen.ts']},
	},
	optimizeDeps: {
		exclude: ['@wip/shared', 'execa'],
	},
	ssr: {
		noExternal: ['@wip/shared'],
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
