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
	build: {
		rollupOptions: {
			external: ['execa', /^node:/],
		},
	},
	ssr: {
		noExternal: ['@wip/shared'],
		external: ['better-sqlite3', 'execa'],
	},
	plugins: [tailwindcss(), tanstackStart(), viteReact()],
});
