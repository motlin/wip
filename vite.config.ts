import {defineConfig} from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 120,
		semi: true,
		singleQuote: false,
		bracketSpacing: false,
		trailingComma: "all",
		arrowParens: "always",
		overrides: [
			{
				files: [".yamllint.yaml", "**/*.yaml", "**/*.yml"],
				options: {
					useTabs: false,
					tabWidth: 2,
				},
			},
		],
	},
	lint: {options: {typeAware: true, typeCheck: true}},
	test: {
		env: {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
		hookTimeout: 30_000,
		testTimeout: 30_000,
	},
});
