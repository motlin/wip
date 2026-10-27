import {defineConfig} from "vite-plus";

export default defineConfig({
	test: {
		setupFiles: ["./src/test/git-env-setup.ts"],
		globals: true,
		// Many tests drive real git, git-test and just subprocesses. On a loaded machine (several
		// suites and worktree precommits at once) those measured up to ~48s, so the timeout only
		// guards against hangs and stays well clear of slow-but-healthy runs.
		hookTimeout: 120_000,
		testTimeout: 120_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/test/**"],
		},
	},
});
