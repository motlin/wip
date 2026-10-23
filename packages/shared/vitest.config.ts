import {defineConfig} from "vite-plus";

export default defineConfig({
	test: {
		setupFiles: ["./src/test/git-env-setup.ts"],
		globals: true,
		hookTimeout: 30_000,
		testTimeout: 30_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/test/**"],
		},
	},
});
