import {defineConfig, type Plugin, type PluginOption} from "vite-plus";
import {tanstackStart} from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import {fileURLToPath} from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const serverOnlyModules = ["execa", "better-sqlite3", "pino", "pino-pretty", "drizzle-orm/better-sqlite3"];

// Stub server-only modules so Vite's dev client doesn't walk into execa → unicorn-magic
function stubServerModules(): Plugin {
	return {
		name: "stub-server-modules",
		enforce: "pre",
		resolveId(id, _importer, options) {
			if (
				!options?.ssr &&
				serverOnlyModules.some((moduleName) => id === moduleName || id.startsWith(moduleName + "/"))
			) {
				return {id: `\0stub:${id}`, moduleSideEffects: false};
			}
		},
		load(id) {
			if (id.startsWith("\0stub:")) {
				const noop =
					'new Proxy(() => noop, { get: (_, p) => p === Symbol.toPrimitive ? () => "" : noop, apply: () => noop })';
				return `const noop = ${noop}; export default noop; export const execa = noop; export const drizzle = noop;`;
			}
		},
	};
}

const plugins = [stubServerModules(), tailwindcss(), tanstackStart(), viteReact()] as unknown as PluginOption[];

export default defineConfig({
	root: webRoot,
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		port: 3456,
		host: true,
		allowedHosts: [".halibut-wyrm.ts.net"],
		watch: {},
	},
	optimizeDeps: {
		exclude: ["@wip/shared", "execa"],
	},
	build: {
		rollupOptions: {
			external: ["execa", /^node:/],
		},
	},
	ssr: {
		noExternal: ["@wip/shared"],
		external: ["better-sqlite3", "execa"],
	},
	test: {
		env: {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
		globals: true,
		hookTimeout: 30_000,
		testTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/routeTree.gen.ts"],
		},
	},
	plugins,
});
