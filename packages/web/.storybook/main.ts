import type {StorybookConfig} from "@storybook/react-vite";
import type {PluginOption} from "vite-plus";

process.title = "wip-storybook";

const config: StorybookConfig =
{
	stories: ["../src/stories/**/*.mdx", "../src/stories/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
	addons: ["@chromatic-com/storybook", "@storybook/addon-docs", "@storybook/addon-a11y"],
	framework:
	{
		name: "@storybook/react-vite",
		options: {},
	},
	// Storybook inherits vite.config.ts; TanStack Start's plugins add the app's own entries, which make the
	// Storybook build fail with "multiple entries detected", and stories need none of them.
	viteFinal: (viteConfig) => (
	{
		...viteConfig,
		plugins: withoutTanStack(viteConfig.plugins ?? []),
	}),
};

function withoutTanStack(plugins: PluginOption[]): PluginOption[]
{
	return plugins.flatMap((plugin) =>
	{
		if (Array.isArray(plugin))
		{
			return [withoutTanStack(plugin)];
		}
		const name = plugin && typeof plugin === "object" && "name" in plugin ? plugin.name : "";
		return name.startsWith("tanstack") ? [] : [plugin];
	});
}
export default config;
