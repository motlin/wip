import {defineConfig, type Plugin, type PluginOption} from "vite-plus";
import {tanstackStart} from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import {fileURLToPath} from "node:url";

process.title = "wip-web-dev";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const serverOnlyModules = ["execa", "better-sqlite3", "pino", "pino-pretty", "drizzle-orm/better-sqlite3"];

// Stub server-only modules so Vite's dev client doesn't walk into execa → unicorn-magic
function stubServerModules(): Plugin {
	return {
		name: "stub-server-modules",
		enforce: "pre",
		resolveId(id, _importer, options) {
			if (
				!options.ssr &&
				serverOnlyModules.some((moduleName) => id === moduleName || id.startsWith(moduleName + "/"))
			) {
				return {id: `\0stub:${id}`, moduleSideEffects: false};
			}
			return undefined;
		},
		load(id) {
			if (id.startsWith("\0stub:")) {
				const noop =
					'new Proxy(() => noop, { get: (_, p) => p === Symbol.toPrimitive ? () => "" : noop, apply: () => noop })';
				return `const noop = ${noop}; export default noop; export const execa = noop; export const drizzle = noop;`;
			}
			return undefined;
		},
	};
}

const plugins: PluginOption[] = [stubServerModules(), tailwindcss(), tanstackStart(), viteReact()];

export default defineConfig({
	root: webRoot,
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		// Dev on 3457 (wip-dev.m4.notlin.com); production `just serve` keeps 3456 (wip.m4.notlin.com)
		port: 3457,
		strictPort: true,
		host: "127.0.0.1",
		allowedHosts: ["wip-dev.m4.notlin.com"],
		watch: {},
		// Transform the entry, routes, and query layer at startup instead of on the first request
		warmup: {
			clientFiles: ["./src/client.tsx", "./src/routes/**/*.tsx", "./src/lib/queries.ts"],
			ssrFiles: ["./src/server.ts", "./src/routes/__root.tsx", "./src/lib/server-fns.ts"],
		},
	},
	optimizeDeps: {
		exclude: ["@wip/shared", "execa"],
		// TanStack Start excludes @tanstack/react-router and start-client-core (virtual-module imports), which leaves
		// their router-core/seroval internals as ~70 unbundled requests; pre-bundle those leaves, including every
		// router-core subpath so all importers share one instance. The rest are listed so no route discovers them late.
		include: [
			"@tanstack/react-router > @tanstack/router-core",
			"@tanstack/react-router > @tanstack/router-core/isServer",
			"@tanstack/react-router > @tanstack/router-core/ssr/client",
			"@tanstack/react-router > @tanstack/router-core/scroll-restoration-script",
			"@tanstack/react-router > @tanstack/history",
			"@tanstack/react-start > @tanstack/start-client-core > @tanstack/start-fn-stubs",
			"@tanstack/react-start > @tanstack/start-client-core > seroval",
			"@tanstack/react-router > @tanstack/router-core > seroval",
			"@tanstack/react-router > @tanstack/router-core > seroval-plugins/web",
			"@tanstack/react-router > @tanstack/router-core > cookie-es",
			"@tanstack/react-query",
			"@tanstack/react-query-devtools",
			"@tanstack/react-query-persist-client",
			"@tanstack/query-sync-storage-persister",
			"@tanstack/react-router-ssr-query",
			"@tanstack/react-virtual",
			"@git-diff-view/react",
			"@git-diff-view/core",
			"ansi-to-html",
			"lucide-react",
			"zod",
		],
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
		setupFiles: [path.resolve(webRoot, "../shared/src/test/git-env-setup.ts")],
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
