import {describe, it, expect} from "vite-plus/test";
import {
	CategorySchema,
	TransitionSchema,
	STATE_MACHINE,
	getTransitionsFrom,
	getTransitionsTo,
	applyTransition,
	CATEGORY_ORDER,
	CATEGORY_COLUMNS,
} from "@wip/shared";
import {CATEGORY_PRIORITY} from "./category-actions.js";

describe("STATE_MACHINE", () => {
	const allCategories = CategorySchema.options;

	it("all from states are valid categories", () => {
		for (const t of STATE_MACHINE) {
			expect(allCategories).toContain(t.from);
		}
	});

	it("all to states are valid categories", () => {
		for (const t of STATE_MACHINE) {
			expect(allCategories).toContain(t.to);
		}
	});

	it("has no duplicate transitions", () => {
		const keys = STATE_MACHINE.map((t) => `${t.from}--${t.transition}-->${t.to}`);
		const unique = new Set(keys);
		expect(keys.length).toBe(unique.size);
	});

	it("landed is terminal: no outgoing transitions", () => {
		expect(getTransitionsFrom("landed")).toStrictEqual([]);
	});

	it("blocked todos can be snoozed", () => {
		expect(applyTransition("blocked", "snooze")).toBe("snoozed");
	});

	it("every non-terminal state has at least one outgoing transition", () => {
		const terminal = new Set(["skippable", "landed"]);
		for (const cat of allCategories) {
			if (terminal.has(cat)) continue;
			const outgoing = getTransitionsFrom(cat);
			expect(outgoing.length, `${cat} has no outgoing transitions`).toBeGreaterThan(0);
		}
	});

	it("getTransitionsFrom returns correct results", () => {
		const fromReadyToTest = getTransitionsFrom("ready_to_test");
		expect(fromReadyToTest.length).toBeGreaterThan(0);
		expect(fromReadyToTest.every((t) => t.from === "ready_to_test")).toBe(true);
	});

	it("getTransitionsTo returns correct results", () => {
		const toSnoozed = getTransitionsTo("snoozed");
		expect(toSnoozed.length).toBeGreaterThan(0);
		expect(toSnoozed.every((t) => t.to === "snoozed")).toBe(true);
	});

	it("snoozed state has unsnooze transition", () => {
		const fromSnoozed = getTransitionsFrom("snoozed");
		expect(fromSnoozed.some((t) => t.transition === "unsnooze")).toBe(true);
	});

	it("has no snoozed self-loop", () => {
		const selfLoops = STATE_MACHINE.filter((t) => t.from === "snoozed" && t.to === "snoozed");
		expect(selfLoops).toStrictEqual([]);
	});

	it("unsnooze is a passive return to every state that can be snoozed", () => {
		const unsnoozeTargets = STATE_MACHINE.filter((t) => t.transition === "unsnooze").map((t) => ({
			from: t.from,
			to: t.to,
			kind: t.kind,
		}));
		const snoozeSources = STATE_MACHINE.filter((t) => t.transition === "snooze").map((t) => ({
			from: "snoozed",
			to: t.from,
			kind: "passive",
		}));
		expect(unsnoozeTargets).toStrictEqual(snoozeSources);
	});

	it("pushing settles passively into pushed_no_pr or checks_unknown", () => {
		const fromPushing = getTransitionsFrom("pushing")
			.filter((t) => t.transition !== "snooze")
			.map((t) => ({to: t.to, kind: t.kind}));
		expect(fromPushing).toStrictEqual([
			{to: "pushed_no_pr", kind: "passive"},
			{to: "checks_unknown", kind: "passive"},
		]);
	});

	it("every non-terminal, non-snoozed state can be snoozed", () => {
		const terminal = new Set(["skippable", "snoozed", "landed"]);
		for (const cat of allCategories) {
			if (terminal.has(cat)) continue;
			const transitions = getTransitionsFrom(cat);
			expect(
				transitions.some((t) => t.transition === "snooze"),
				`${cat} should have a snooze transition`,
			).toBe(true);
		}
	});

	it("all snooze transitions are active", () => {
		const snoozeTransitions = STATE_MACHINE.filter((t) => t.transition === "snooze");
		for (const t of snoozeTransitions) {
			expect(t.kind, `snooze from ${t.from} should be active`).toBe("active");
		}
	});

	it("has no dead plan or split states in the enum or the graph", () => {
		const dead = new Set(["plan_unreviewed", "plan_approved", "needs_split"]);
		const graphStates = new Set(STATE_MACHINE.flatMap((t) => [t.from, t.to]));
		expect(allCategories.filter((c) => dead.has(c))).toStrictEqual([]);
		expect([...graphStates].filter((s) => dead.has(s))).toStrictEqual([]);
		expect(TransitionSchema.options.filter((t) => ["generate_plan", "approve_plan"].includes(t))).toStrictEqual([]);
	});

	it("split is an active transition from the pre-push branch states into ready_to_test, since split commits are new and untested", () => {
		expect(STATE_MACHINE.filter((t) => t.transition === "split")).toStrictEqual([
			{from: "ready_to_test", transition: "split", to: "ready_to_test", kind: "active"},
			{from: "test_failed", transition: "split", to: "ready_to_test", kind: "active"},
			{from: "needs_rebase", transition: "split", to: "ready_to_test", kind: "active"},
			{from: "rebase_unknown", transition: "split", to: "ready_to_test", kind: "active"},
			{from: "ready_to_push", transition: "split", to: "ready_to_test", kind: "active"},
		]);
	});

	it("TransitionSchema does not include edit_code or refresh", () => {
		const transitions = TransitionSchema.options;
		expect(transitions).not.toContain("edit_code");
		expect(transitions).not.toContain("refresh");
	});

	it("every transition has a valid kind (active or passive)", () => {
		for (const t of STATE_MACHINE) {
			expect(
				["active", "passive"],
				`${t.from} --${t.transition}--> ${t.to} missing valid kind, got "${t.kind}"`,
			).toContain(t.kind);
		}
	});
});

describe("canonical category order", () => {
	const allCategories = CategorySchema.options;

	it("CATEGORY_ORDER is the CategorySchema order with every category exactly once", () => {
		expect(CATEGORY_ORDER).toStrictEqual(allCategories);
		expect(new Set(CATEGORY_ORDER).size).toBe(allCategories.length);
	});

	it("CATEGORY_COLUMNS flatten to the canonical order", () => {
		expect(CATEGORY_COLUMNS.flat()).toStrictEqual(allCategories);
	});

	it("CATEGORY_PRIORITY includes every category exactly once", () => {
		expect(CATEGORY_PRIORITY.toSorted()).toStrictEqual(allCategories.toSorted());
	});

	it("every state in the graph has a column, including pushing", () => {
		const graphStates = new Set(STATE_MACHINE.flatMap((t) => [t.from, t.to]));
		const placed = new Set(CATEGORY_COLUMNS.flat());
		expect([...graphStates].filter((s) => !placed.has(s))).toStrictEqual([]);
		expect(graphStates.has("pushing")).toBe(true);
	});

	it("rebase_conflicts -> ready_to_test is a forward edge", () => {
		expect(CATEGORY_PRIORITY.indexOf("rebase_conflicts")).toBeLessThan(CATEGORY_PRIORITY.indexOf("ready_to_test"));
	});

	it("rebase_stuck can only be aborted or snoozed, never rescued", () => {
		expect(getTransitionsFrom("rebase_stuck")).toStrictEqual([
			{from: "rebase_stuck", transition: "snooze", to: "snoozed", kind: "active"},
			{from: "rebase_stuck", transition: "abort_rebase", to: "needs_rebase", kind: "active"},
		]);
	});
});

describe("applyTransition", () => {
	it("returns the target state for a valid transition", () => {
		expect(applyTransition("ready_to_test", "run_test")).toBe("test_running");
	});

	it("returns the target state for test_pass from test_running", () => {
		expect(applyTransition("test_running", "test_pass")).toBe("ready_to_push");
	});

	it("returns the target state for test_fail from test_running", () => {
		expect(applyTransition("test_running", "test_fail")).toBe("test_failed");
	});

	it("returns the target state for cancel_test from test_running", () => {
		expect(applyTransition("test_running", "cancel_test")).toBe("ready_to_test");
	});

	it("returns undefined for an invalid transition", () => {
		expect(applyTransition("approved", "run_test")).toBeUndefined();
	});

	it("returns undefined for a transition not valid from the given state", () => {
		expect(applyTransition("ready_to_push", "test_pass")).toBeUndefined();
	});

	it("returns the target state for snooze from test_running", () => {
		expect(applyTransition("test_running", "snooze")).toBe("snoozed");
	});

	it("returns the target state for rebase transition", () => {
		expect(applyTransition("needs_rebase", "rebase")).toBe("ready_to_test");
	});

	it("resolves rebase to the outcome passed in", () => {
		expect(applyTransition("needs_rebase", "rebase", "clean")).toBe("ready_to_test");
		expect(applyTransition("needs_rebase", "rebase", "conflicts")).toBe("rebase_conflicts");
		expect(applyTransition("rebase_unknown", "rebase", "conflicts")).toBe("rebase_conflicts");
		expect(applyTransition("rebase_unknown", "rebase", "clean")).toBe("ready_to_test");
	});

	it("ignores outcome for transitions without outcome variants", () => {
		expect(applyTransition("test_running", "snooze", "conflicts")).toBe("snoozed");
	});

	it("returns landed for merge from approved", () => {
		expect(applyTransition("approved", "merge")).toBe("landed");
	});

	it("returns approved for approve from changes_requested", () => {
		expect(applyTransition("changes_requested", "approve")).toBe("approved");
	});

	it("returns checks_passed for dismiss_review from changes_requested", () => {
		expect(applyTransition("changes_requested", "dismiss_review")).toBe("checks_passed");
	});

	it("returns checks_passed for dismiss_review from review_comments", () => {
		expect(applyTransition("review_comments", "dismiss_review")).toBe("checks_passed");
	});

	it("returns checks_passed for dismiss_review from approved", () => {
		expect(applyTransition("approved", "dismiss_review")).toBe("checks_passed");
	});

	it("returns changes_requested for request_changes from review_comments", () => {
		expect(applyTransition("review_comments", "request_changes")).toBe("changes_requested");
	});

	it("returns changes_requested for request_changes from approved", () => {
		expect(applyTransition("approved", "request_changes")).toBe("changes_requested");
	});

	it("returns checks_passed for checks_pass from checks_unknown", () => {
		expect(applyTransition("checks_unknown", "checks_pass")).toBe("checks_passed");
	});

	it("returns checks_failed for checks_fail from checks_unknown", () => {
		expect(applyTransition("checks_unknown", "checks_fail")).toBe("checks_failed");
	});

	it("returns ready_to_test for split from ready_to_push", () => {
		expect(applyTransition("ready_to_push", "split")).toBe("ready_to_test");
	});

	it("returns undefined for split once the branch is pushed", () => {
		expect(applyTransition("checks_passed", "split")).toBeUndefined();
	});

	it("returns test_running for run_test from no_test", () => {
		expect(applyTransition("no_test", "run_test")).toBe("test_running");
	});
});
