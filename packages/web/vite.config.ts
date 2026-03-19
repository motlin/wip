import {defineConfig, type Plugin} from 'vite';
import {tanstackStart} from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Stub server-only modules so Vite's dev client doesn't walk into execa → unicorn-magic
function stubServerModules(): Plugin {
	const SERVER_ONLY = ['execa', 'better-sqlite3', 'pino', 'pino-pretty'];
	return {
		name: 'stub-server-modules',
		enforce: 'pre',
		resolveId(id, _importer, options) {
			if (!options?.ssr && SERVER_ONLY.some((mod) => id === mod || id.startsWith(mod + '/'))) {
				return {id: `\0stub:${id}`, moduleSideEffects: false};
			}
		},
		load(id) {
			if (id.startsWith('\0stub:')) {
				return 'export default {}; export const execa = () => { throw new Error("server-only"); };';
			}
		},
	};
}

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		port: 3456,
		host: true,
		allowedHosts: true,
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
	plugins: [stubServerModules(), tailwindcss(), tanstackStart(), viteReact()],
});
