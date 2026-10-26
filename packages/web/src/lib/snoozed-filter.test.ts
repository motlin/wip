import {describe, it, expect} from "vite-plus/test";

import type {SnoozedChild} from "@wip/shared";

import {flagSnoozedChildren} from "./snoozed-filter";
import {makeChild} from "./test-factories";

function makeSnoozed(project: string, sha: string, patchId: string | null = null): SnoozedChild {
	return {
		project,
		sha,
		shortSha: sha.slice(0, 7),
		subject: "snoozed",
		until: "2026-05-01T00:00:00.000Z",
		patchId,
		orphaned: false,
	};
}

describe("flagSnoozedChildren", () => {
	it("flags children whose (project, sha) appears in the snoozed list, keeping them", () => {
		const a = makeChild({project: "proj", sha: "a".repeat(40)});
		const b = makeChild({project: "proj", sha: "b".repeat(40)});
		const snoozed = [makeSnoozed("proj", "a".repeat(40))];

		expect(flagSnoozedChildren([a, b], "proj", snoozed)).toStrictEqual([{...a, onHold: true}, b]);
	});

	it("flags a rebased child whose patch-id matches a snoozed entry at its old sha", () => {
		const rebased = makeChild({project: "proj", sha: "c".repeat(40), patchId: "p".repeat(40)});
		const other = makeChild({project: "proj", sha: "d".repeat(40), patchId: "q".repeat(40)});
		const snoozed = [makeSnoozed("proj", "a".repeat(40), "p".repeat(40))];

		expect(flagSnoozedChildren([rebased, other], "proj", snoozed)).toStrictEqual([
			{...rebased, onHold: true},
			other,
		]);
	});

	it("ignores snoozed entries for other projects", () => {
		const a = makeChild({project: "proj", sha: "a".repeat(40)});
		const snoozedElsewhere = [makeSnoozed("other-proj", "a".repeat(40))];

		expect(flagSnoozedChildren([a], "proj", snoozedElsewhere)).toStrictEqual([a]);
	});

	it("returns the input unchanged when snoozed list is empty", () => {
		const a = makeChild({project: "proj", sha: "a".repeat(40)});
		expect(flagSnoozedChildren([a], "proj", [])).toStrictEqual([a]);
	});

	it("returns the input unchanged when snoozed list is undefined", () => {
		const a = makeChild({project: "proj", sha: "a".repeat(40)});
		expect(flagSnoozedChildren([a], "proj", undefined)).toStrictEqual([a]);
	});
});
