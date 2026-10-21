import {describe, it, expect} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";

import {ProjectSection} from "./advance-plan-project-section.js";
import type {AdvancePlanProjectSummary} from "../lib/server-fns.js";

function readyProject(overrides: Partial<AdvancePlanProjectSummary> = {}): AdvancePlanProjectSummary {
	return {
		project: "aggregator-creator",
		projectDir: "/tmp/aggregator-creator",
		upstreamRef: "origin/main",
		upstreamRemote: "origin",
		upstreamBranch: "main",
		remote: "owner/repo",
		status: "ready",
		baselineNeedsTest: true,
		baselineSha: "64a776f02e46a65c121e7775a024bb0daf0b9a62",
		concurrency: 1,
		branches: [],
		...overrides,
	};
}

describe("ProjectSection baseline label", () => {
	it("does not claim a cached green baseline for a skipped project whose baseline was never evaluated", () => {
		const markup = renderToStaticMarkup(
			<ProjectSection
				project={readyProject({
					status: "skipped",
					detail: "no test configured",
					baselineNeedsTest: false,
					baselineSha: undefined,
					branches: [],
				})}
				runBaselineTest={async () => Promise.resolve()}
			/>,
		);

		expect(markup).not.toContain("Baseline cached green");
		expect(markup).not.toContain("Baseline needs test");
	});
});

describe("ProjectSection baseline control", () => {
	it("offers a Run Baseline Tests control for a ready project with no branches whose baseline needs a test", () => {
		const markup = renderToStaticMarkup(
			<ProjectSection project={readyProject()} runBaselineTest={async () => Promise.resolve()} />,
		);

		expect(markup).toContain("Run Baseline Tests");
		expect(markup).not.toContain("No branch actions available.");
	});

	it("omits the Run Baseline Tests control when the baseline is already cached green", () => {
		const markup = renderToStaticMarkup(
			<ProjectSection
				project={readyProject({baselineNeedsTest: false})}
				runBaselineTest={async () => Promise.resolve()}
			/>,
		);

		expect(markup).not.toContain("Run Baseline Tests");
	});
});
