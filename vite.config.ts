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
	staged: {
		"*": "vp check --fix",
	},
	lint: {options: {typeAware: true, typeCheck: true}},
});
