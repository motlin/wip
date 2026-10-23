import {defineConfig} from "vite-plus";
import path from "node:path";
import {fileURLToPath} from "node:url";

const cliRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	test: {
		setupFiles: [path.resolve(cliRoot, "../shared/src/test/git-env-setup.ts")],
		globals: true,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "dist/**"],
		},
	},
});
