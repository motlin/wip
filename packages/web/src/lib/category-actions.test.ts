import {describe, it, expect} from "vite-plus/test";
import {
	CATEGORIES,
	CATEGORY_PRIORITY,
	CATEGORY_PRIORITY_REVERSED,
	TRANSITION_TO_ACTION,
	getTransitionActions,
	SUPPLEMENTARY_ACTIONS,
	primaryAction,
	type PrimaryAction,
} from "./category-actions";
import {CategorySchema, type Category} from "@wip/shared";
import {getTransitionsFrom} from "@wip/shared/schemas.js";

function indexOf(cat: Category): number {
	return CATEGORY_PRIORITY.indexOf(cat);
}

describe("CATEGORIES", () => {
	it("has an entry for every category in CategorySchema", () => {
		for (const cat of CategorySchema.options) {
			expect(CATEGORIES).toHaveProperty(cat);
		}
	});

	it("llmCommand is undefined or a non-empty string for every category", () => {
		const commands = Object.values(CATEGORIES)
			.map((config) => config.llmCommand)
			.filter((command) => command !== undefined);
		for (const command of commands) {
			expect(typeof command).toBe("string");
			expect(command.length).toBeGreaterThan(0);
		}
	});

	it("maps test_failed to /build:fix", () => {
		expect(CATEGORIES.test_failed.llmCommand).toBe("/build:fix");
	});

	it("maps rebase_conflicts to /git:conflicts", () => {
		expect(CATEGORIES.rebase_conflicts.llmCommand).toBe("/git:conflicts");
	});

	it("maps ready_to_test to /build:test-branch", () => {
		expect(CATEGORIES.ready_to_test.llmCommand).toBe("/build:test-branch");
	});

	it("maps local_changes to /git:commit", () => {
		expect(CATEGORIES.local_changes.llmCommand).toBe("/git:commit");
	});

	it("makes Abort rebase the first action for rebase_stuck, with no rescue command", () => {
		expect({first: CATEGORIES.rebase_stuck.actions[0], llmCommand: CATEGORIES.rebase_stuck.llmCommand}).toEqual({
			first: "abort_rebase",
			llmCommand: undefined,
		});
	});

	it("models Abort rebase as the rebase_stuck --abort_rebase--> needs_rebase edge, so the next action is a rebase", () => {
		expect({
			edges: getTransitionsFrom("rebase_stuck")
				.filter((t) => t.transition === "abort_rebase")
				.map((t) => t.to),
			action: TRANSITION_TO_ACTION.abort_rebase,
			nextActions: CATEGORIES.needs_rebase.actions.includes("rebase_local"),
		}).toEqual({edges: ["needs_rebase"], action: "abort_rebase", nextActions: true});
	});

	it("maps checks_failed to /gha", () => {
		expect(CATEGORIES.checks_failed.llmCommand).toBe("/gha");
	});

	it("gives upstream_red the red palette and /github:gha", () => {
		expect({palette: CATEGORIES.upstream_red.palette, llmCommand: CATEGORIES.upstream_red.llmCommand}).toEqual({
			palette: "red",
			llmCommand: "/github:gha",
		});
	});

	it("ranks upstream_red first", () => {
		expect(CATEGORY_PRIORITY_REVERSED[0]).toBe("upstream_red");
	});
});

describe("TRANSITION_TO_ACTION", () => {
	it("maps run_test to test", () => {
		expect(TRANSITION_TO_ACTION.run_test).toBe("test");
	});

	it("maps push to push", () => {
		expect(TRANSITION_TO_ACTION.push).toBe("push");
	});

	it("maps force_push to force_push", () => {
		expect(TRANSITION_TO_ACTION.force_push).toBe("force_push");
	});

	it("maps commit to commit", () => {
		expect(TRANSITION_TO_ACTION.commit).toBe("commit");
	});

	it("maps create_pr to create_pr", () => {
		expect(TRANSITION_TO_ACTION.create_pr).toBe("create_pr");
	});

	it("maps rebase to rebase_local", () => {
		expect(TRANSITION_TO_ACTION.rebase).toBe("rebase_local");
	});

	it("maps create_branch to create_branch", () => {
		expect(TRANSITION_TO_ACTION.create_branch).toBe("create_branch");
	});

	it("maps merge to merge", () => {
		expect(TRANSITION_TO_ACTION.merge).toBe("merge");
	});

	it("maps split to split", () => {
		expect(TRANSITION_TO_ACTION.split).toBe("split");
	});
});

describe("getTransitionActions", () => {
	it("returns test for ready_to_test", () => {
		expect(getTransitionActions("ready_to_test")).toContain("test");
	});

	it("returns push and force_push for ready_to_push", () => {
		const actions = getTransitionActions("ready_to_push");
		expect(actions).toContain("push");
		expect(actions).toContain("force_push");
	});

	it("returns create_pr for pushed_no_pr", () => {
		expect(getTransitionActions("pushed_no_pr")).toContain("create_pr");
	});

	it("returns commit for local_changes", () => {
		expect(getTransitionActions("local_changes")).toContain("commit");
	});

	it("returns rebase_local for needs_rebase", () => {
		expect(getTransitionActions("needs_rebase")).toContain("rebase_local");
	});

	it("returns create_branch for detached_head", () => {
		expect(getTransitionActions("detached_head")).toContain("create_branch");
	});

	it("offers split exactly from the states with a split transition", () => {
		expect(CategorySchema.options.filter((cat) => getTransitionActions(cat).includes("split"))).toStrictEqual([
			"ready_to_test",
			"test_failed",
			"needs_rebase",
			"rebase_unknown",
			"ready_to_push",
		]);
	});
});

describe("actions arrays are derived from state machine", () => {
	it("ready_to_test actions start with transition-derived actions followed by supplementary", () => {
		const actions = CATEGORIES.ready_to_test.actions;
		expect(actions).toContain("test");
		expect(actions).toContain("refresh");
		expect(actions).toContain("rename");
		expect(actions).toContain("delete_branch");
	});

	it("test_failed actions contain test from state machine", () => {
		const actions = CATEGORIES.test_failed.actions;
		expect(actions).toContain("test");
		expect(actions).toContain("view_test_log");
	});

	it("checks_failed actions contain force_push from state machine", () => {
		const actions = CATEGORIES.checks_failed.actions;
		expect(actions).toContain("force_push");
		expect(actions).toContain("apply_fixes");
	});

	it("every category actions array matches transition-derived + supplementary", () => {
		for (const cat of CategorySchema.options) {
			const config = CATEGORIES[cat];
			const transitionActions = getTransitionActions(cat);
			const supplementary = SUPPLEMENTARY_ACTIONS[cat] ?? [];
			const expected = [...transitionActions, ...supplementary];
			expect(config.actions).toStrictEqual(expected);
		}
	});
});

describe("CATEGORY_PRIORITY", () => {
	it("includes every category exactly once", () => {
		expect(CATEGORY_PRIORITY).toHaveLength(CategorySchema.options.length);
		expect(new Set(CATEGORY_PRIORITY).size).toBe(CategorySchema.options.length);
		for (const cat of CategorySchema.options) {
			expect(CATEGORY_PRIORITY).toContain(cat);
		}
	});

	it("places snoozed first", () => {
		expect(CATEGORY_PRIORITY[0]).toBe("snoozed");
	});

	it("places skippable second (right after snoozed)", () => {
		expect(CATEGORY_PRIORITY[1]).toBe("skippable");
	});

	it("orders ideas before test flow", () => {
		expect(indexOf("untriaged")).toBeLessThan(indexOf("ready_to_test"));
		expect(indexOf("triaged")).toBeLessThan(indexOf("ready_to_test"));
	});

	it("orders test flow before push flow", () => {
		expect(indexOf("ready_to_test")).toBeLessThan(indexOf("ready_to_push"));
		expect(indexOf("test_running")).toBeLessThan(indexOf("ready_to_push"));
	});

	it("orders push flow before CI flow", () => {
		expect(indexOf("ready_to_push")).toBeLessThan(indexOf("checks_unknown"));
		expect(indexOf("pushed_no_pr")).toBeLessThan(indexOf("checks_unknown"));
	});

	it("orders CI flow before review flow", () => {
		expect(indexOf("checks_unknown")).toBeLessThan(indexOf("checks_passed"));
		expect(indexOf("checks_running")).toBeLessThan(indexOf("checks_passed"));
	});

	it("orders review flow last, followed only by terminal landed and the forced upstream_red", () => {
		expect(indexOf("checks_passed")).toBeLessThan(indexOf("approved"));
		expect(CATEGORY_PRIORITY.slice(-3)).toStrictEqual(["approved", "landed", "upstream_red"]);
	});

	it("places test_failed adjacent to test_running (not after push states)", () => {
		expect(Math.abs(indexOf("test_failed") - indexOf("test_running"))).toBeLessThanOrEqual(1);
	});

	it("places checks_failed adjacent to checks_running or checks_passed", () => {
		const cfIdx = indexOf("checks_failed");
		const crIdx = indexOf("checks_running");
		const cpIdx = indexOf("checks_passed");
		expect(cfIdx).toBeGreaterThan(crIdx);
		expect(cfIdx).toBeLessThan(cpIdx);
	});

	it("places rebase states before push states", () => {
		expect(indexOf("needs_rebase")).toBeLessThan(indexOf("ready_to_push"));
		expect(indexOf("rebase_conflicts")).toBeLessThan(indexOf("ready_to_push"));
	});
});

describe("primaryAction", () => {
	const expected: Record<Category, PrimaryAction | null> = {
		upstream_red: "run_claude",
		landed: null,
		approved: "merge",
		changes_requested: "open_pr_link",
		review_comments: "open_pr_link",
		checks_passed: "open_pr_link",
		checks_failed: "run_claude",
		checks_running: "open_pr_link",
		checks_unknown: "refresh",
		pushed_no_pr: "create_pr",
		ready_to_push: "push",
		pushing: null,
		needs_rebase: "rebase_local",
		rebase_unknown: "rebase_local",
		rebase_conflicts: "run_claude",
		rebase_stuck: "abort_rebase",
		test_failed: "run_claude",
		ready_to_test: "test",
		test_running: "view_test_log",
		detached_head: "create_branch",
		local_changes: "commit",
		no_test: "push",
		untriaged: "do_task",
		triaged: "do_task",
		blocked: null,
		skippable: null,
		snoozed: null,
	};

	it("names one primary action for every category", () => {
		expect(Object.fromEntries(CategorySchema.options.map((cat) => [cat, primaryAction(cat)]))).toStrictEqual(
			expected,
		);
	});

	it("picks a primary the category can actually perform", () => {
		const unperformable = CategorySchema.options.filter((cat) => {
			const primary = primaryAction(cat);
			if (primary === null || primary === "do_task") return false;
			if (primary === "run_claude") return CATEGORIES[cat].llmCommand === undefined;
			return !CATEGORIES[cat].actions.includes(primary);
		});
		expect(unperformable).toStrictEqual([]);
	});
});
