import {describe, it, expect, vi} from "vite-plus/test";
import {renderToStaticMarkup} from "react-dom/server";
import type {IssueResult} from "@wip/shared";

import {KanbanColumn} from "./kanban-column";
import {SECTION_PAGE_SIZE} from "../lib/visible-items";

vi.mock("./issue-card", () => ({
	IssueCard: () => <span data-card="" />,
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
});
