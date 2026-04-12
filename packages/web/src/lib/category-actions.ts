import {
  type Category,
  type Transition,
  CategorySchema,
  getTransitionsFrom,
  STATE_MACHINE,
} from "@wip/shared";

export type Action =
  | "open_pr_link"
  | "force_push"
  | "rebase_local"
  | "apply_fixes"
  | "rename"
  | "create_pr"
  | "push"
  | "commit"
  | "test"
  | "view_test_log"
  | "delete_branch"
  | "refresh"
  | "review_plan"
  | "implement"
  | "merge"
  | "create_branch"
  | "generate_plan";

// Maps state-machine transitions to UI action names.
// Only transitions that correspond to a user-triggerable action are included.
export const TRANSITION_TO_ACTION: Partial<Record<Transition, Action>> = {
  run_test: "test",
  push: "push",
  force_push: "force_push",
  commit: "commit",
  create_pr: "create_pr",
  rebase: "rebase_local",
  approve_plan: "review_plan",
  merge: "merge",
  create_branch: "create_branch",
  generate_plan: "generate_plan",
};

// Derive user-triggerable actions from state machine transitions for a category.
export function getTransitionActions(category: Category): Action[] {
  return (
    getTransitionsFrom(category)
      .map((t) => TRANSITION_TO_ACTION[t.transition])
      .filter((a): a is Action => a !== undefined)
      // Deduplicate (e.g. push + force_push both from ready_to_push)
      .filter((a, i, arr) => arr.indexOf(a) === i)
  );
}

// Non-state-changing actions that are added per category beyond what the state machine provides.
export const SUPPLEMENTARY_ACTIONS: Partial<Record<Category, readonly Action[]>> = {
  approved: ["open_pr_link", "refresh"],
  changes_requested: ["open_pr_link", "refresh"],
  review_comments: ["open_pr_link", "refresh"],
  checks_passed: ["open_pr_link", "refresh"],
  checks_failed: ["open_pr_link", "apply_fixes", "refresh"],
  checks_running: ["open_pr_link", "force_push", "refresh"],
  checks_unknown: ["open_pr_link", "force_push", "refresh"],
  pushed_no_pr: ["force_push", "refresh", "rename", "delete_branch"],
  ready_to_push: ["refresh", "rename", "delete_branch"],
  needs_split: ["refresh", "rename"],
  needs_rebase: ["refresh", "rename"],
  rebase_unknown: ["refresh", "rename"],
  rebase_conflicts: ["refresh", "rename"],
  rebase_stuck: ["refresh"],
  test_failed: ["view_test_log", "refresh", "rename", "delete_branch"],
  ready_to_test: ["refresh", "rename", "delete_branch"],
  test_running: ["view_test_log", "refresh"],
  local_changes: ["rename"],
  no_test: ["rename", "delete_branch"],
  plan_approved: ["implement"],
};

function buildActions(category: Category): readonly Action[] {
  const transitionActions = getTransitionActions(category);
  const supplementary = SUPPLEMENTARY_ACTIONS[category] ?? [];
  return [...transitionActions, ...supplementary];
}

export type PaletteKey =
  | "green"
  | "red"
  | "blue"
  | "yellow"
  | "orange"
  | "amber"
  | "purple"
  | "dim"
  | "muted";

interface PaletteEntry {
  text: string;
  dot: string;
  column: string;
}

const PALETTE: Record<PaletteKey, PaletteEntry> = {
  green: {
    text: "text-green-700 dark:text-green-400",
    dot: "bg-green-500",
    column: "bg-green-column",
  },
  red: {
    text: "text-red-700 dark:text-red-400",
    dot: "bg-red-500",
    column: "bg-red-column",
  },
  blue: {
    text: "text-blue-700 dark:text-blue-400",
    dot: "bg-blue-500",
    column: "bg-blue-column",
  },
  yellow: {
    text: "text-yellow-700 dark:text-yellow-400",
    dot: "bg-yellow-500",
    column: "bg-yellow-column",
  },
  orange: {
    text: "text-orange-700 dark:text-orange-400",
    dot: "bg-orange-500",
    column: "bg-yellow-column",
  },
  amber: {
    text: "text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
    column: "bg-yellow-column",
  },
  purple: {
    text: "text-purple-700 dark:text-purple-400",
    dot: "bg-purple-500",
    column: "bg-purple-column",
  },
  dim: {
    text: "text-text-300",
    dot: "bg-text-300",
    column: "bg-dim-column",
  },
  muted: {
    text: "text-text-500",
    dot: "bg-text-500",
    column: "bg-dim-column",
  },
};

export interface CategoryConfig {
  label: string;
  palette: PaletteKey;
  actions: readonly Action[];
  llmCommand?: string;
}

export const CATEGORIES: Record<Category, CategoryConfig> = {
  approved: { label: "Approved", palette: "green", actions: buildActions("approved") },
  changes_requested: {
    label: "Changes Requested",
    palette: "purple",
    actions: buildActions("changes_requested"),
  },
  review_comments: {
    label: "Review Comments",
    palette: "blue",
    actions: buildActions("review_comments"),
  },
  checks_passed: {
    label: "Checks Passed",
    palette: "blue",
    actions: buildActions("checks_passed"),
  },
  checks_failed: {
    label: "Checks Failed",
    palette: "red",
    actions: buildActions("checks_failed"),
    llmCommand: "/gha",
  },
  checks_running: {
    label: "Checks Running",
    palette: "yellow",
    actions: buildActions("checks_running"),
  },
  checks_unknown: {
    label: "Checks Unknown",
    palette: "dim",
    actions: buildActions("checks_unknown"),
  },
  pushed_no_pr: { label: "Needs PR", palette: "blue", actions: buildActions("pushed_no_pr") },
  ready_to_push: {
    label: "Ready to Push",
    palette: "green",
    actions: buildActions("ready_to_push"),
  },
  needs_split: {
    label: "Needs Split",
    palette: "orange",
    actions: buildActions("needs_split"),
    llmCommand: "/git:split-branch",
  },
  needs_rebase: {
    label: "Needs Rebase",
    palette: "orange",
    actions: buildActions("needs_rebase"),
    llmCommand: "/git:rebase-all",
  },
  rebase_unknown: {
    label: "Rebase Unknown",
    palette: "amber",
    actions: buildActions("rebase_unknown"),
  },
  rebase_conflicts: {
    label: "Rebase Conflicts",
    palette: "red",
    actions: buildActions("rebase_conflicts"),
    llmCommand: "/git:conflicts",
  },
  rebase_stuck: {
    label: "Rebase Stuck",
    palette: "red",
    actions: buildActions("rebase_stuck"),
    llmCommand: "/git:conflicts",
  },
  test_failed: {
    label: "Test Failed",
    palette: "red",
    actions: buildActions("test_failed"),
    llmCommand: "/build:fix",
  },
  ready_to_test: {
    label: "Ready to Test",
    palette: "yellow",
    actions: buildActions("ready_to_test"),
    llmCommand: "/build:test-branch",
  },
  test_running: { label: "Test Running", palette: "yellow", actions: buildActions("test_running") },
  detached_head: {
    label: "Detached HEAD",
    palette: "yellow",
    actions: buildActions("detached_head"),
  },
  local_changes: {
    label: "Local Changes",
    palette: "dim",
    actions: buildActions("local_changes"),
    llmCommand: "/git:commit",
  },
  no_test: { label: "No Test", palette: "dim", actions: buildActions("no_test") },
  untriaged: { label: "Untriaged", palette: "muted", actions: buildActions("untriaged") },
  triaged: { label: "Triaged", palette: "purple", actions: buildActions("triaged") },
  plan_unreviewed: {
    label: "Plan Unreviewed",
    palette: "orange",
    actions: buildActions("plan_unreviewed"),
  },
  plan_approved: {
    label: "Plan Approved",
    palette: "green",
    actions: buildActions("plan_approved"),
    llmCommand: "/markdown-tasks:do-one-task",
  },
  skippable: { label: "Skippable", palette: "muted", actions: buildActions("skippable") },
  snoozed: { label: "Snoozed", palette: "muted", actions: buildActions("snoozed") },
};

export function categoryTextClass(category: Category): string {
  return PALETTE[CATEGORIES[category].palette].text;
}

export function categoryDotClass(category: Category): string {
  return PALETTE[CATEGORIES[category].palette].dot;
}

export function categoryColumnClass(category: Category): string {
  return PALETTE[CATEGORIES[category].palette].column;
}

// Edges to ignore when computing topological order.
// These are either orthogonal (snooze/unsnooze) or back-edges (retry loops
// that go backward in the SDLC flow, like test_failed -> run_test -> test_running).
// Without excluding them, Kahn's algorithm silently drops all nodes in a cycle.
// Identified by specific (from, to) pairs, not transition names, because the same
// transition can be a forward edge in one context and a back-edge in another
// (e.g. run_test: ready_to_test -> test_running is forward, test_failed -> test_running is backward).
const BACK_EDGES = new Set([
  // Retry loops
  "test_failed->test_running",
  "test_running->ready_to_test",
  "checks_failed->checks_running",
  "changes_requested->checks_running",
  "review_comments->checks_running",
  "rebase_conflicts->ready_to_test",
  // Review back-edges (dismiss/re-review goes backward in SDLC)
  "changes_requested->checks_passed",
  "review_comments->checks_passed",
  "approved->checks_passed",
  "approved->changes_requested",
]);

function isBackEdge(t: { from: Category; to: Category; transition: string }): boolean {
  if (t.from === t.to) return true;
  if (t.transition === "snooze" || t.transition === "unsnooze") return true;
  return BACK_EDGES.has(`${t.from}->${t.to}`);
}

// Column assignments for tie-breaking: when multiple nodes have in-degree 0,
// prefer nodes from earlier columns. This keeps failure states adjacent to
// their success counterparts (e.g. test_failed near test_running, not after push states).
const COLUMN_ORDER: Category[][] = [
  ["untriaged", "triaged", "plan_unreviewed", "plan_approved"],
  ["detached_head", "local_changes", "no_test"],
  ["ready_to_test", "test_running", "test_failed"],
  ["needs_rebase", "rebase_conflicts", "needs_split"],
  ["ready_to_push", "pushed_no_pr"],
  ["checks_unknown", "checks_running", "checks_failed"],
  ["checks_passed", "review_comments", "changes_requested", "approved"],
];

function columnIndex(cat: Category): number {
  for (let i = 0; i < COLUMN_ORDER.length; i++) {
    const row = COLUMN_ORDER[i]!.indexOf(cat);
    if (row >= 0) return i * 100 + row;
  }
  return 9999;
}

// Derive category order from STATE_MACHINE topology using topological sort.
// This ensures columns flow left-to-right following the SDLC progression.
function deriveCategoryPriority(): Category[] {
  const allStates = new Set<Category>();
  for (const t of STATE_MACHINE) {
    allStates.add(t.from);
    allStates.add(t.to);
  }
  for (const cat of CategorySchema.options) {
    allStates.add(cat);
  }

  // Build adjacency map and in-degree counts (excluding back-edges)
  const adjMap = new Map<Category, Category[]>();
  const inDegree = new Map<Category, number>();
  for (const state of allStates) {
    adjMap.set(state, []);
    inDegree.set(state, 0);
  }

  for (const t of STATE_MACHINE) {
    if (isBackEdge(t)) continue;
    const neighbors = adjMap.get(t.from)!;
    if (!neighbors.includes(t.to)) {
      neighbors.push(t.to);
      inDegree.set(t.to, (inDegree.get(t.to) ?? 0) + 1);
    }
  }

  // Kahn's topological sort with tie-breaking by column position
  const queue: Category[] = [];
  for (const [state, degree] of inDegree) {
    if (degree === 0) queue.push(state);
  }
  queue.sort((a, b) => columnIndex(a) - columnIndex(b));

  const sorted: Category[] = [];
  while (queue.length > 0) {
    const state = queue.shift()!;
    sorted.push(state);
    for (const neighbor of adjMap.get(state) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        // Insert sorted by column position to maintain tie-breaking
        const idx = queue.findIndex((q) => columnIndex(q) > columnIndex(neighbor));
        if (idx === -1) queue.push(neighbor);
        else queue.splice(idx, 0, neighbor);
      }
    }
  }

  // Place special orthogonal states at the front:
  // - snoozed first, skippable second (both are "not actionable now" categories)
  const rest = sorted.filter((s) => s !== "snoozed" && s !== "skippable");
  const result: Category[] = [
    ...(allStates.has("snoozed") ? ["snoozed" as Category] : []),
    ...(allStates.has("skippable") ? ["skippable" as Category] : []),
    ...rest,
  ];

  return result;
}

export const CATEGORY_PRIORITY: Category[] = deriveCategoryPriority();
export const CATEGORY_PRIORITY_REVERSED: Category[] = [...CATEGORY_PRIORITY].reverse();
