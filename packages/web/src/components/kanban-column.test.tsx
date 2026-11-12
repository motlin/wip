import {describe, it, expect, vi} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import type {IssueResult} from "@wip/shared";
import {readyIndex, type ReadyToLandState} from "@wip/shared/ready-to-land.js";
import {makeChild} from "../lib/test-factories.js";
import {LandContext, type LandContextValue} from "../lib/land-context.js";

import {KanbanColumn} from "./kanban-column.js";
import {SECTION_PAGE_SIZE} from "../lib/visible-items.js";

vi.mock("./issue-card", () => ({
	IssueCard: () => <span data-card="" />,
}));
vi.mock("./commit-card", () => ({
	CommitCard: ({category, commit}: {category?: string; commit: {subject: string}}) => (
		<span data-commit-category={category ?? "none"}>{commit.subject}</span>
	),
}));

function issues(count: number): IssueResult[] {
	return Array.from({length: count}, (_, i) => ({number: i, url: `https://example.test/${i}`}) as IssueResult);
}

describe("KanbanColumn", () => {
	it("renders one page of cards and a show-more control for a large column", () => {
		const markup = renderToStaticMarkup(
			<KanbanColumn category="untriaged" items={{issues: issues(1768)}} count={1768} />,
		);

		expect(markup.match(/data-card=/g)?.length ?? 0).toBe(SECTION_PAGE_SIZE);
		expect(markup).toContain(`Show ${1768 - SECTION_PAGE_SIZE} more`);
	});

	it("renders every card without a show-more control when the column fits one page", () => {
		const markup = renderToStaticMarkup(
			<KanbanColumn category="untriaged" items={{issues: issues(3)}} count={3} />,
		);

		expect(markup.match(/data-card=/g)?.length ?? 0).toBe(3);
		expect(markup).not.toContain("more</button>");
	});

	it("passes its category to commit cards", () => {
		const commit = makeChild({branch: undefined});
		const markup = renderToStaticMarkup(
			<KanbanColumn category="test_failed" items={{gitChildren: [commit]}} count={1} />,
		);

		expect(markup).toEqual(expect.stringContaining('data-commit-category="test_failed"'));
	});
});

const older = makeChild({sha: "a".repeat(40), subject: "Older commit", branch: undefined});
const high = makeChild({sha: "b".repeat(40), subject: "High priority commit", branch: undefined});
const state: ReadyToLandState = {
	slots: 2,
	ready: [
		{project: "test", id: older.sha, sha: older.sha},
		{project: "test", id: high.sha, sha: high.sha, priority: "high"},
	],
	inFlight: [],
	next: [],
	stoppedProjects: [],
};
/** Only readyItemOf is read by the landing order. */
const land = {readyItemOf: readyIndex(state)} as LandContextValue;

describe("KanbanColumn landing columns", () => {
	it("orders landing cards by the ready buffer's stable row order, as /queue's cards do: priority first", () => {
		const markup = renderToStaticMarkup(
			<LandContext.Provider value={land}>
				<KanbanColumn category="ready_to_push" items={{gitChildren: [older, high]}} count={2} />
			</LandContext.Provider>,
		);

		expect([...markup.matchAll(/data-commit-category="ready_to_push">([^<]*)</g)].map((m) => m[1])).toStrictEqual([
			"High priority commit",
			"Older commit",
		]);
	});
});
