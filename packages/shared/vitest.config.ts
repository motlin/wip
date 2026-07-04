import {defineConfig} from "vite-plus";

export default defineConfig({
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
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/test/**"],
		},
	},
});
