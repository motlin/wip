import type {Preview} from "@storybook/react-vite";
import {createElement, Fragment} from "react";
import {IconSprite} from "../src/components/icons.js";
import "./styles.css";

const preview: Preview = {
	// Icons are <use> references into the sprite the root document renders.
	decorators: [(Story) => createElement(Fragment, null, createElement(IconSprite), createElement(Story))],
	parameters: {
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		backgrounds: {
			default: "light",
			values: [
				{
					name: "light",
					value: "#ffffff",
				},
				{
					name: "dark",
					value: "#1b1b1d",
				},
			],
		},
	},
	globalTypes: {
		theme: {
			name: "Theme",
			description: "Global theme for components",
			defaultValue: "light",
			toolbar: {
				icon: "circlehollow",
				items: ["light", "dark"],
				title: "Theme",
				dynamicTitle: true,
			},
		},
	},
};

export default preview;
