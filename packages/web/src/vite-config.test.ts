import {describe, expect, it} from "vite-plus/test";

import config from "../vite.config.js";

describe("dev server config", () => {
	it("pre-bundles the router internals TanStack Start leaves unbundled, plus the app's heavy deps", () => {
		expect(config.optimizeDeps).toStrictEqual({
			exclude: ["@wip/shared", "execa"],
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
				"@tanstack/react-router-ssr-query",
				"@tanstack/react-virtual",
				"@git-diff-view/react",
				"@git-diff-view/core",
				"ansi-to-html",
				"lucide-react",
				"zod",
			],
		});
	});

	it("warms up the client entry, every route, and the query layer", () => {
		expect(config.server?.warmup).toStrictEqual({
			clientFiles: ["./src/client.tsx", "./src/routes/**/*.tsx", "./src/lib/queries.ts"],
			ssrFiles: ["./src/server.ts", "./src/routes/__root.tsx", "./src/lib/server-fns.ts"],
		});
	});
});
