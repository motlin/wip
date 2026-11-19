import {defineConfig} from "vite-plus";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {diagnosticsVitestOptions} from "../shared/src/test/test-diagnostics.ts";

const cliRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(
	{
		test:
		{
			// Only the sources: dist is gitignored and never cleaned, so after checking out an older commit
			// it still holds compiled tests from later commits that would run against an older @wip/shared.
			include: ["src/**/*.test.ts"],
			setupFiles: [path.resolve(cliRoot, "../shared/src/test/git-env-setup.ts")],
			globals: true,
			...diagnosticsVitestOptions("cli"),
			coverage:
			{
				provider: "v8",
				include: ["src/**/*.ts"],
				exclude: ["src/**/*.test.ts", "dist/**"],
			},
		},
	},
);
