import {describe, it, expect} from "vite-plus/test";

import {renderTree, type ReportNode} from "./advance-report.js";

describe("renderTree", () => {
	it("renders a nested project/branch tree with status emoji and detail", () => {
		const root: ReportNode = {
			label: "advance run",
			status: "green",
			children: [
				{
					label: "liftwizard",
					status: "green",
					children: [
						{label: "feature-a", status: "green", children: []},
						{label: "feature-b", status: "stuck", detail: "stuck: FooTest.bar", children: []},
					],
				},
				{
					label: "avalon",
					status: "upstream_fixed",
					detail: "upstream fixed on base abc123",
					children: [{label: "zizmor-pr", status: "green", children: []}],
				},
				{label: "data-converter", status: "skipped", detail: "dirty", children: []},
			],
		};

		expect(renderTree(root)).toStrictEqual(
			[
				"✅ advance run",
				"├─ ✅ liftwizard",
				"│  ├─ ✅ feature-a",
				"│  └─ 🛑 feature-b — stuck: FooTest.bar",
				"├─ ⚠️ avalon — upstream fixed on base abc123",
				"│  └─ ✅ zizmor-pr",
				"└─ ⏭️ data-converter — dirty",
			].join("\n"),
		);
	});

	it("renders a leaf node with no children", () => {
		expect(renderTree({label: "solo", status: "red", children: []})).toStrictEqual("❌ solo");
	});
});
