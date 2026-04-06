import { z } from "zod";

export const ReviewStatusSchema = z.enum([
  "clean",
  "approved",
  "changes_requested",
  "commented",
  "no_pr",
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CheckStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "failed",
  "none",
  "unknown",
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TestStatusSchema = z.enum(["passed", "failed", "running", "unknown"]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

// Kanban left-to-right: full SDLC flow
export const CategorySchema = z.enum([
  "snoozed",
  "skippable",
  "untriaged",
  "triaged",
  "plan_unreviewed",
  "plan_approved",
  "no_test",
  "detached_head",
  "local_changes",
  "ready_to_test",
  "test_running",
  "test_failed",
  "needs_rebase",
  "rebase_unknown",
  "rebase_conflicts",
  "rebase_stuck",
  "needs_split",
  "ready_to_push",
  "pushed_no_pr",
  "checks_unknown",
  "checks_running",
  "checks_failed",
  "checks_passed",
  "review_comments",
  "changes_requested",
  "approved",
]);
export type Category = z.infer<typeof CategorySchema>;

// Named transitions: verbs that move items between states
export const TransitionSchema = z.enum([
  "snooze",
  "unsnooze",
  "generate_plan",
  "approve_plan",
  "create_branch",
  "commit",
  "run_test",
  "test_pass",
  "test_fail",
  "cancel_test",
  "rebase",
  "resolve_conflicts",
  "split",
  "push",
  "force_push",
  "create_pr",
  "checks_start",
  "checks_pass",
  "checks_fail",
  "review_comment",
  "request_changes",
  "approve",
  "dismiss_review",
  "merge",
]);
export type Transition = z.infer<typeof TransitionSchema>;

export interface StateTransition {
  from: Category;
  transition: Transition;
  to: Category;
  kind: "active" | "passive";
}

// Formal state machine: every valid (from, action, to) triple.
// States are nouns/adjectives (what the item IS); transitions are verbs (what HAPPENS).
export const STATE_MACHINE: readonly StateTransition[] = [
  // Snooze/unsnooze — available from most states
  { from: "ready_to_test", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "test_failed", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "ready_to_push", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "needs_rebase", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "rebase_unknown", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "rebase_stuck", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "needs_split", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "pushed_no_pr", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "checks_passed", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "checks_failed", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "untriaged", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "triaged", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "plan_unreviewed", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "plan_approved", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "no_test", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "detached_head", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "local_changes", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "rebase_conflicts", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "checks_unknown", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "checks_running", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "review_comments", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "changes_requested", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "approved", transition: "snooze", to: "snoozed", kind: "active" },
  { from: "snoozed", transition: "unsnooze", to: "snoozed", kind: "active" },

  // Plan flow
  { from: "triaged", transition: "generate_plan", to: "plan_unreviewed", kind: "active" },
  { from: "plan_unreviewed", transition: "approve_plan", to: "plan_approved", kind: "active" },
  { from: "plan_approved", transition: "create_branch", to: "ready_to_test", kind: "active" },

  // Local development flow
  { from: "triaged", transition: "create_branch", to: "ready_to_test", kind: "active" },
  { from: "untriaged", transition: "create_branch", to: "ready_to_test", kind: "active" },
  { from: "detached_head", transition: "create_branch", to: "ready_to_test", kind: "active" },
  { from: "local_changes", transition: "commit", to: "ready_to_test", kind: "active" },

  // Testing flow
  { from: "no_test", transition: "run_test", to: "test_running", kind: "active" },
  { from: "ready_to_test", transition: "run_test", to: "test_running", kind: "active" },
  { from: "test_failed", transition: "run_test", to: "test_running", kind: "active" },
  { from: "test_running", transition: "test_pass", to: "ready_to_push", kind: "passive" },
  { from: "test_running", transition: "test_fail", to: "test_failed", kind: "passive" },
  { from: "test_running", transition: "cancel_test", to: "ready_to_test", kind: "active" },
  { from: "test_running", transition: "snooze", to: "snoozed", kind: "active" },

  // Rebase flow
  { from: "needs_rebase", transition: "rebase", to: "ready_to_test", kind: "active" },
  { from: "needs_rebase", transition: "rebase", to: "rebase_conflicts", kind: "active" },
  { from: "rebase_unknown", transition: "rebase", to: "ready_to_test", kind: "active" },
  { from: "rebase_unknown", transition: "rebase", to: "rebase_conflicts", kind: "active" },
  {
    from: "rebase_conflicts",
    transition: "resolve_conflicts",
    to: "ready_to_test",
    kind: "active",
  },
  { from: "rebase_stuck", transition: "resolve_conflicts", to: "ready_to_test", kind: "active" },

  // Split flow (multi-commit branches)
  { from: "needs_split", transition: "split", to: "ready_to_push", kind: "active" },

  // Push flow
  { from: "ready_to_push", transition: "push", to: "pushed_no_pr", kind: "active" },
  { from: "ready_to_push", transition: "force_push", to: "pushed_no_pr", kind: "active" },
  { from: "no_test", transition: "push", to: "pushed_no_pr", kind: "active" },

  // PR creation
  { from: "pushed_no_pr", transition: "create_pr", to: "checks_unknown", kind: "active" },

  // CI checks flow
  { from: "checks_unknown", transition: "checks_start", to: "checks_running", kind: "passive" },
  { from: "checks_unknown", transition: "checks_pass", to: "checks_passed", kind: "passive" },
  { from: "checks_unknown", transition: "checks_fail", to: "checks_failed", kind: "passive" },
  { from: "checks_running", transition: "checks_pass", to: "checks_passed", kind: "passive" },
  { from: "checks_running", transition: "checks_fail", to: "checks_failed", kind: "passive" },
  { from: "checks_failed", transition: "force_push", to: "checks_running", kind: "active" },

  // Code review flow
  { from: "checks_passed", transition: "review_comment", to: "review_comments", kind: "passive" },
  {
    from: "checks_passed",
    transition: "request_changes",
    to: "changes_requested",
    kind: "passive",
  },
  { from: "checks_passed", transition: "approve", to: "approved", kind: "passive" },
  { from: "review_comments", transition: "approve", to: "approved", kind: "passive" },
  {
    from: "review_comments",
    transition: "request_changes",
    to: "changes_requested",
    kind: "passive",
  },
  { from: "changes_requested", transition: "dismiss_review", to: "checks_passed", kind: "passive" },
  { from: "review_comments", transition: "dismiss_review", to: "checks_passed", kind: "passive" },
  { from: "approved", transition: "request_changes", to: "changes_requested", kind: "passive" },
  { from: "approved", transition: "dismiss_review", to: "checks_passed", kind: "passive" },
  { from: "changes_requested", transition: "approve", to: "approved", kind: "passive" },
  { from: "changes_requested", transition: "force_push", to: "checks_running", kind: "active" },
  { from: "review_comments", transition: "force_push", to: "checks_running", kind: "active" },

  // Merge
  { from: "approved", transition: "merge", to: "approved", kind: "active" },

  // Skippable — orthogonal state (no incoming transitions; derived from item.skippable flag)
  // Skippable items are terminal and cannot transition to other states via actions
  // Only way to exit is to mark as unskippable (implicit, not modeled as explicit transition)
] as const;

// Lookup helpers
export function getTransitionsFrom(state: Category): StateTransition[] {
  return STATE_MACHINE.filter((t) => t.from === state);
}

export function getTransitionsTo(state: Category): StateTransition[] {
  return STATE_MACHINE.filter((t) => t.to === state);
}

export function applyTransition(from: Category, transition: Transition): Category | undefined {
  const match = STATE_MACHINE.find((t) => t.from === from && t.transition === transition);
  return match?.to;
}

// Reusable validated string schemas
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const shortShaSchema = z.string().regex(/^[a-f0-9]{7,40}$/);
const branchSchema = z.string().regex(/^[a-zA-Z0-9._\x2f-]+$/);
const dateSchema = z.string().date();
const hexColorSchema = z.string().regex(/^[0-9a-fA-F]{6}$/);
export const LabelSchema = z.object({ name: z.string().min(1), color: hexColorSchema });
export const RepositorySchema = z.object({
  name: z.string().min(1),
  nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
});

export const ProjectInfoSchema = z.object({
  name: z.string(),
  dir: z.string(),
  remote: z.string(),
  upstreamRemote: z.string(),
  upstreamBranch: z.string(),
  upstreamRef: z.string(),
  dirty: z.boolean(),
  detachedHead: z.boolean(),
  branchCount: z.number(),
  hasTestConfigured: z.boolean(),
  rebaseInProgress: z.boolean(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ChildCommitSchema = z.object({
  sha: shaSchema,
  shortSha: shortShaSchema,
  subject: z.string(),
  date: dateSchema,
  branch: branchSchema.optional(),
  testStatus: TestStatusSchema,
  checkStatus: CheckStatusSchema,
  skippable: z.boolean(),
  pushedToRemote: z.boolean(),
  localAhead: z.boolean().optional(),
  needsRebase: z.boolean().optional(),
  reviewStatus: ReviewStatusSchema,
  prUrl: z.string().url().optional(),
  prNumber: z.number().optional(),
  failedChecks: z
    .array(z.object({ name: z.string(), url: z.string().url().optional() }))
    .optional(),
  behind: z.boolean().optional(),
  commitsBehind: z.number().optional(),
  commitsAhead: z.number().optional(),
  rebaseable: z.boolean().optional(),
  alreadyOnRemote: z.object({ branch: branchSchema }).optional(),
});
export type ChildCommit = z.infer<typeof ChildCommitSchema>;

export const DeleteBranchInputSchema = z.object({
  project: z.string(),
  branch: branchSchema,
});
export type DeleteBranchInput = z.infer<typeof DeleteBranchInputSchema>;

export const ForcePushInputSchema = z.object({
  project: z.string(),
  branch: branchSchema,
});
export type ForcePushInput = z.infer<typeof ForcePushInputSchema>;

export const RenameBranchInputSchema = z.object({
  project: z.string(),
  oldBranch: branchSchema,
  newBranch: branchSchema,
});
export type RenameBranchInput = z.infer<typeof RenameBranchInputSchema>;

export const ApplyFixesInputSchema = z.object({
  project: z.string(),
  branch: branchSchema,
  prNumber: z.number(),
});
export type ApplyFixesInput = z.infer<typeof ApplyFixesInputSchema>;

export const RebaseLocalInputSchema = z.object({
  project: z.string(),
  branch: branchSchema,
});
export type RebaseLocalInput = z.infer<typeof RebaseLocalInputSchema>;

// --- Work item types (each represents a distinct kind of work) ---

// Flat git child result: all fields from ChildCommit (minus `behind`) plus server-computed fields.
// Client discriminates by checking child.branch and child.prUrl.
export const GitChildResultSchema = z.object({
  project: z.string(),
  remote: z.string(),
  sha: shaSchema,
  shortSha: shortShaSchema,
  subject: z.string(),
  date: dateSchema,
  branch: branchSchema.optional(),
  testStatus: TestStatusSchema,
  checkStatus: CheckStatusSchema,
  skippable: z.boolean(),
  pushedToRemote: z.boolean(),
  localAhead: z.boolean().optional(),
  needsRebase: z.boolean().optional(),
  reviewStatus: ReviewStatusSchema,
  prUrl: z.string().url().optional(),
  prNumber: z.number().optional(),
  failedChecks: z
    .array(z.object({ name: z.string(), url: z.string().url().optional() }))
    .optional(),
  commitsBehind: z.number().optional(),
  commitsAhead: z.number().optional(),
  rebaseable: z.boolean().optional(),
  alreadyOnRemote: z.object({ branch: branchSchema }).optional(),
  failureTail: z.string().optional(),
  suggestedBranch: branchSchema.optional(),
  blockReason: z.string().optional(),
  blockCommand: z.string().optional(),
});
export type GitChildResult = z.infer<typeof GitChildResultSchema>;

// A GitHub issue assigned to me
export const PlanStatusSchema = z.enum(["none", "unreviewed", "approved"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

// A task from a todo.md file
export const TodoItemSchema = z.object({
  project: z.string(),
  title: z.string(),
  sourceFile: z.string(),
  sourceLabel: z.string(),
  planStatus: PlanStatusSchema.optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const ActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  compareUrl: z.string().url().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ProjectBoardItemSchema = z.object({
  project: z.string(),
  remote: z.string(),
  url: z.string().url().optional(),
  number: z.number().int().positive().optional(),
  title: z.string(),
  status: z.string(),
  type: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]),
  labels: z.array(LabelSchema),
});
export type ProjectBoardItem = z.infer<typeof ProjectBoardItemSchema>;

export const SnoozedChildSchema = z.object({
  sha: shaSchema,
  project: z.string(),
  shortSha: shortShaSchema,
  subject: z.string(),
  until: z.string().datetime().nullable(),
});
export type SnoozedChild = z.infer<typeof SnoozedChildSchema>;

// Server function input schemas
export const PushChildInputSchema = z.object({
  project: z.string(),
  sha: shaSchema,
  branch: branchSchema.optional(),
});
export type PushChildInput = z.infer<typeof PushChildInputSchema>;

export const TestChildInputSchema = z.object({
  project: z.string(),
  sha: shaSchema,
});
export type TestChildInput = z.infer<typeof TestChildInputSchema>;

export const SnoozeChildInputSchema = z.object({
  project: z.string(),
  sha: shaSchema,
  until: z.string().datetime().nullable(),
});
export type SnoozeChildInput = z.infer<typeof SnoozeChildInputSchema>;

export const UnsnoozeChildInputSchema = z.object({
  sha: shaSchema,
  project: z.string(),
});
export type UnsnoozeChildInput = z.infer<typeof UnsnoozeChildInputSchema>;

export const CancelTestInputSchema = z.object({
  id: z.string(),
});
export type CancelTestInput = z.infer<typeof CancelTestInputSchema>;

export const CreatePrInputSchema = z.object({
  project: z.string(),
  branch: branchSchema,
  title: z.string(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
});
export type CreatePrInput = z.infer<typeof CreatePrInputSchema>;

export const RefreshChildInputSchema = z.object({
  project: z.string(),
  sha: shaSchema,
});
export type RefreshChildInput = z.infer<typeof RefreshChildInputSchema>;

export const CreateBranchInputSchema = z.object({
  project: z.string(),
  sha: shaSchema,
  branchName: branchSchema,
});
export type CreateBranchInput = z.infer<typeof CreateBranchInputSchema>;

export const MergePrInputSchema = z.object({
  project: z.string(),
  prNumber: z.number(),
});
export type MergePrInput = z.infer<typeof MergePrInputSchema>;

export const TestQueueJobSchema = z.object({
  id: z.string(),
  project: z.string(),
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  branch: z.string().optional(),
  status: z.enum(["queued", "running", "passed", "failed", "cancelled"]),
  message: z.string().optional(),
  queuedAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export type TestQueueJob = z.infer<typeof TestQueueJobSchema>;
