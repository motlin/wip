import {z} from "zod";

export const ReviewStatusSchema = z.enum(["clean", "approved", "changes_requested", "commented", "no_pr"]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CheckStatusSchema = z.enum(["pending", "running", "passed", "failed", "none", "unknown"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TestStatusSchema = z.enum(["passed", "failed", "running", "unknown"]);
export type TestStatus = z.infer<typeof TestStatusSchema>;

export const MergeStateStatusSchema = z.enum([
	"BEHIND",
	"BLOCKED",
	"CLEAN",
	"DIRTY",
	"DRAFT",
	"HAS_HOOKS",
	"UNKNOWN",
	"UNSTABLE",
]);
export type MergeStateStatus = z.infer<typeof MergeStateStatusSchema>;

// The one canonical category order: the full SDLC flow left to right, grouped
// into lifecycle-phase columns. CategorySchema, the /states graph columns and the
// queue's topological tie-break all derive from this.
export const CATEGORY_COLUMNS = [
	// Overrides and ideas
	["snoozed", "skippable", "untriaged", "triaged"],
	// Early local
	["detached_head", "local_changes", "no_test"],
	// Test cycle
	["ready_to_test", "test_running", "test_failed"],
	// Rebase
	["needs_rebase", "rebase_unknown", "rebase_conflicts", "rebase_stuck"],
	// Push
	["ready_to_push", "pushing", "pushed_no_pr"],
	// CI
	["checks_unknown", "checks_running", "checks_failed"],
	// Review
	["checks_passed", "review_comments", "changes_requested", "approved"],
] as const;

export type Category = (typeof CATEGORY_COLUMNS)[number][number];
export const CATEGORY_ORDER: readonly Category[] = CATEGORY_COLUMNS.flat();
export const CategorySchema = z.enum(CATEGORY_ORDER);

// Named transitions: verbs that move items between states
export const TransitionSchema = z.enum([
	"snooze",
	"unsnooze",
	"create_branch",
	"commit",
	"run_test",
	"test_pass",
	"test_fail",
	"cancel_test",
	"rebase",
	"resolve_conflicts",
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
	"push_complete",
]);
export type Transition = z.infer<typeof TransitionSchema>;

export type TransitionOutcome = "clean" | "conflicts";

export interface StateTransition {
	from: Category;
	transition: Transition;
	to: Category;
	kind: "active" | "passive";
	// Set on nondeterministic transitions: which outcome selects this edge.
	outcome?: TransitionOutcome;
}

// Every valid (from, action, to) triple except the unsnooze returns, which are derived below.
// States are nouns/adjectives (what the item IS); transitions are verbs (what HAPPENS).
const FLOW_TRANSITIONS: readonly StateTransition[] = [
	// Snooze — available from most states
	{from: "ready_to_test", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "test_failed", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "ready_to_push", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "needs_rebase", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "rebase_unknown", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "rebase_stuck", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "pushed_no_pr", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "checks_passed", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "checks_failed", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "untriaged", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "triaged", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "no_test", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "detached_head", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "local_changes", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "rebase_conflicts", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "checks_unknown", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "checks_running", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "review_comments", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "changes_requested", transition: "snooze", to: "snoozed", kind: "active"},
	{from: "approved", transition: "snooze", to: "snoozed", kind: "active"},

	// Local development flow
	{from: "triaged", transition: "create_branch", to: "ready_to_test", kind: "active"},
	{from: "untriaged", transition: "create_branch", to: "ready_to_test", kind: "active"},
	{from: "detached_head", transition: "create_branch", to: "ready_to_test", kind: "active"},
	{from: "local_changes", transition: "commit", to: "ready_to_test", kind: "active"},

	// Testing flow
	{from: "no_test", transition: "run_test", to: "test_running", kind: "active"},
	{from: "ready_to_test", transition: "run_test", to: "test_running", kind: "active"},
	{from: "test_failed", transition: "run_test", to: "test_running", kind: "active"},
	{from: "test_running", transition: "test_pass", to: "ready_to_push", kind: "passive"},
	{from: "test_running", transition: "test_fail", to: "test_failed", kind: "passive"},
	{from: "test_running", transition: "cancel_test", to: "ready_to_test", kind: "active"},
	{from: "test_running", transition: "snooze", to: "snoozed", kind: "active"},

	// Rebase flow
	{from: "needs_rebase", transition: "rebase", to: "ready_to_test", kind: "active", outcome: "clean"},
	{from: "needs_rebase", transition: "rebase", to: "rebase_conflicts", kind: "active", outcome: "conflicts"},
	{from: "rebase_unknown", transition: "rebase", to: "ready_to_test", kind: "active", outcome: "clean"},
	{from: "rebase_unknown", transition: "rebase", to: "rebase_conflicts", kind: "active", outcome: "conflicts"},
	{
		from: "rebase_conflicts",
		transition: "resolve_conflicts",
		to: "ready_to_test",
		kind: "active",
	},
	{from: "rebase_stuck", transition: "resolve_conflicts", to: "ready_to_test", kind: "active"},

	// Push flow
	{from: "ready_to_push", transition: "push", to: "pushing", kind: "active"},
	{from: "ready_to_push", transition: "force_push", to: "pushed_no_pr", kind: "active"},
	{from: "no_test", transition: "push", to: "pushing", kind: "active"},
	{from: "pushing", transition: "push_complete", to: "pushed_no_pr", kind: "passive"},
	{from: "pushing", transition: "push_complete", to: "checks_unknown", kind: "passive"},
	{from: "pushing", transition: "snooze", to: "snoozed", kind: "active"},

	// PR creation
	{from: "pushed_no_pr", transition: "create_pr", to: "checks_unknown", kind: "active"},

	// CI checks flow
	{from: "checks_unknown", transition: "checks_start", to: "checks_running", kind: "passive"},
	{from: "checks_unknown", transition: "checks_pass", to: "checks_passed", kind: "passive"},
	{from: "checks_unknown", transition: "checks_fail", to: "checks_failed", kind: "passive"},
	{from: "checks_running", transition: "checks_pass", to: "checks_passed", kind: "passive"},
	{from: "checks_running", transition: "checks_fail", to: "checks_failed", kind: "passive"},
	{from: "checks_failed", transition: "force_push", to: "checks_running", kind: "active"},

	// Code review flow
	{from: "checks_passed", transition: "review_comment", to: "review_comments", kind: "passive"},
	{
		from: "checks_passed",
		transition: "request_changes",
		to: "changes_requested",
		kind: "passive",
	},
	{from: "checks_passed", transition: "approve", to: "approved", kind: "passive"},
	{from: "review_comments", transition: "approve", to: "approved", kind: "passive"},
	{
		from: "review_comments",
		transition: "request_changes",
		to: "changes_requested",
		kind: "passive",
	},
	{from: "changes_requested", transition: "dismiss_review", to: "checks_passed", kind: "passive"},
	{from: "review_comments", transition: "dismiss_review", to: "checks_passed", kind: "passive"},
	{from: "approved", transition: "request_changes", to: "changes_requested", kind: "passive"},
	{from: "approved", transition: "dismiss_review", to: "checks_passed", kind: "passive"},
	{from: "changes_requested", transition: "approve", to: "approved", kind: "passive"},
	{from: "changes_requested", transition: "force_push", to: "checks_running", kind: "active"},
	{from: "review_comments", transition: "force_push", to: "checks_running", kind: "active"},

	// Merge
	{from: "approved", transition: "merge", to: "approved", kind: "active"},

	// Skippable — orthogonal state (no incoming transitions; derived from item.skippable flag)
	// Skippable items are terminal and cannot transition to other states via actions
	// Only way to exit is to mark as unskippable (implicit, not modeled as explicit transition)
];

// Formal state machine. Unsnoozing (the timer expiring or the user's Unsnooze) is a passive
// return to whichever state the item is in when it is next classified, so every snoozable
// state gets a return edge.
export const STATE_MACHINE: readonly StateTransition[] = [
	...FLOW_TRANSITIONS,
	...FLOW_TRANSITIONS.filter((t) => t.transition === "snooze").map((t): StateTransition => ({
		from: "snoozed",
		transition: "unsnooze",
		to: t.from,
		kind: "passive",
	})),
];

// Lookup helpers
export function getTransitionsFrom(state: Category): StateTransition[] {
	return STATE_MACHINE.filter((t) => t.from === state);
}

export function getTransitionsTo(state: Category): StateTransition[] {
	return STATE_MACHINE.filter((t) => t.to === state);
}

export function applyTransition(
	from: Category,
	transition: Transition,
	outcome: TransitionOutcome = "clean",
): Category | undefined {
	const matches = STATE_MACHINE.filter((t) => t.from === from && t.transition === transition);
	const match = matches.find((t) => t.outcome === outcome) ?? matches.find((t) => t.outcome === undefined);
	return match?.to;
}

export function mapProjectStatusToCategory(status: string): Category {
	const lower = status.toLowerCase().trim();

	if (lower === "done" || lower === "closed" || lower === "completed") return "approved";
	if (lower === "in progress" || lower === "active" || lower === "doing" || lower === "started")
		return "checks_running";
	if (lower === "in review" || lower === "review") return "checks_passed";

	return "untriaged";
}

// Reusable validated string schemas
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const shortShaSchema = z.string().regex(/^[a-f0-9]{7,40}$/);
const branchSchema = z.string().regex(/^[a-zA-Z0-9._\x2f-]+$/);
const dateSchema = z.iso.date();
const hexColorSchema = z.string().regex(/^[0-9a-fA-F]{6}$/);
export const LabelSchema = z.object({name: z.string().min(1), color: hexColorSchema});
export const RepositorySchema = z.object({
	name: z.string().min(1),
	nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
});

export const ExternalCiBlockerSchema = z.object({
	repository: z.string().regex(/^[^/]+\/[^/]+$/),
	repositoryUrl: z.url(),
	branch: branchSchema,
	failedChecks: z.array(z.object({name: z.string(), url: z.url().optional()})),
});
export type ExternalCiBlocker = z.infer<typeof ExternalCiBlockerSchema>;

export const ProjectInfoSchema = z.object({
	name: z.string(),
	dir: z.string(),
	remote: z.string(),
	originRemote: z.string(),
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
	pushing: z.boolean().optional(),
	localAhead: z.boolean().optional(),
	needsRebase: z.boolean().optional(),
	reviewStatus: ReviewStatusSchema,
	prUrl: z.url().optional(),
	prNumber: z.number().optional(),
	failedChecks: z.array(z.object({name: z.string(), url: z.url().optional()})).optional(),
	externalCiBlockers: z.array(ExternalCiBlockerSchema).optional(),
	behind: z.boolean().optional(),
	commitsBehind: z.number().optional(),
	commitsAhead: z.number().optional(),
	rebaseable: z.boolean().optional(),
	mergeStateStatus: MergeStateStatusSchema.optional(),
	alreadyOnRemote: z.object({branch: branchSchema}).optional(),
	containingBranch: branchSchema.optional(),
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
	kind: z.literal("upstream_ci").optional(),
	project: z.string(),
	remote: z.string(),
	originRemote: z.string(),
	sha: shaSchema,
	shortSha: shortShaSchema,
	subject: z.string(),
	date: dateSchema,
	branch: branchSchema.optional(),
	testStatus: TestStatusSchema,
	checkStatus: CheckStatusSchema,
	skippable: z.boolean(),
	pushedToRemote: z.boolean(),
	pushing: z.boolean().optional(),
	localAhead: z.boolean().optional(),
	needsRebase: z.boolean().optional(),
	reviewStatus: ReviewStatusSchema,
	prUrl: z.url().optional(),
	prNumber: z.number().optional(),
	failedChecks: z.array(z.object({name: z.string(), url: z.url().optional()})).optional(),
	externalCiBlockers: z.array(ExternalCiBlockerSchema).optional(),
	commitsBehind: z.number().optional(),
	commitsAhead: z.number().optional(),
	rebaseable: z.boolean().optional(),
	mergeStateStatus: MergeStateStatusSchema.optional(),
	alreadyOnRemote: z.object({branch: branchSchema}).optional(),
	containingBranch: branchSchema.optional(),
	failureTail: z.string().optional(),
	suggestedBranch: branchSchema.optional(),
	blockReason: z.string().optional(),
	blockCommand: z.string().optional(),
});
export type GitChildResult = z.infer<typeof GitChildResultSchema>;

// A GitHub issue assigned to me
export const GitHubIssueSchema = z.object({
	number: z.number().int().positive(),
	title: z.string().min(1),
	url: z.url(),
	labels: z.array(LabelSchema),
	repository: RepositorySchema,
});
export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;

export const IssueResultSchema = GitHubIssueSchema;
export type IssueResult = z.infer<typeof IssueResultSchema>;

export const GitHubProjectItemSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	status: z.string(),
	type: z.enum(["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]),
	url: z.url().optional(),
	number: z.number().int().positive().optional(),
	repository: z.string().min(1).optional(),
	labels: z.array(LabelSchema),
});
export type GitHubProjectItem = z.infer<typeof GitHubProjectItemSchema>;

// A task from a todo.md file
export const TodoItemSchema = z.object({
	project: z.string(),
	title: z.string(),
	sourceFile: z.string(),
	sourceLabel: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const ActionLogEntrySchema = z.object({
	time: z.number(),
	level: z.number(),
	category: z.string(),
	msg: z.string(),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

export const ActionResultSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
	compareUrl: z.url().optional(),
	logs: z.array(ActionLogEntrySchema).optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ProjectBoardItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	url: z.url().optional(),
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
	until: z.iso.datetime().nullable(),
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
	until: z.iso.datetime().nullable(),
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

export const RunClaudeCommandInputSchema = z.object({
	project: z.string(),
	sha: shaSchema,
	branch: branchSchema,
	command: z.string(),
});
export type RunClaudeCommandInput = z.infer<typeof RunClaudeCommandInputSchema>;

export const TaskTypeSchema = z.enum(["test", "claude", "rebase", "push", "ladder"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskQueueJobSchema = z.object({
	id: z.string(),
	taskType: TaskTypeSchema.default("test"),
	project: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	branch: z.string().optional(),
	command: z.string().optional(),
	status: z.enum(["queued", "running", "passed", "failed", "cancelled"]),
	message: z.string().optional(),
	queuedAt: z.number(),
	startedAt: z.number().optional(),
	finishedAt: z.number().optional(),
});
export type TaskQueueJob = z.infer<typeof TaskQueueJobSchema>;

// Backward-compatible aliases
export const TestQueueJobSchema = TaskQueueJobSchema;
export type TestQueueJob = TaskQueueJob;
