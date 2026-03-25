import {z} from 'zod';

export const ReviewStatusSchema = z.enum(['clean', 'approved', 'changes_requested', 'commented', 'no_pr']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CheckStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'none', 'unknown']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TestStatusSchema = z.enum(['passed', 'failed', 'unknown']);
export type TestStatus = z.infer<typeof TestStatusSchema>;

// Kanban left-to-right: full SDLC flow
export const CategorySchema = z.enum([
	'snoozed',
	'skippable',
	'not_started',
	'no_test',
	'detached_head',
	'local_changes',
	'ready_to_test',
	'test_failed',
	'needs_rebase',
	'needs_split',
	'ready_to_push',
	'pushed_no_pr',
	'checks_unknown',
	'checks_running',
	'checks_failed',
	'checks_passed',
	'review_comments',
	'changes_requested',
	'approved',
]);
export type Category = z.infer<typeof CategorySchema>;

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
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ChildCommitSchema = z.object({
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	date: z.string(),
	branch: z.string().optional(),
	testStatus: TestStatusSchema,
	checkStatus: CheckStatusSchema,
	skippable: z.boolean(),
	pushedToRemote: z.boolean(),
	needsRebase: z.boolean().optional(),
	reviewStatus: ReviewStatusSchema,
	prUrl: z.string().optional(),
	prNumber: z.number().optional(),
	failedChecks: z.array(z.object({name: z.string(), url: z.string().optional()})).optional(),
	behind: z.boolean().optional(),
	commitsBehind: z.number().optional(),
	commitsAhead: z.number().optional(),
	rebaseable: z.boolean().optional(),
});
export type ChildCommit = z.infer<typeof ChildCommitSchema>;

export const DeleteBranchInputSchema = z.object({
	project: z.string(),
	branch: z.string(),
});
export type DeleteBranchInput = z.infer<typeof DeleteBranchInputSchema>;

export const ForcePushInputSchema = z.object({
	project: z.string(),
	branch: z.string(),
});
export type ForcePushInput = z.infer<typeof ForcePushInputSchema>;

export const RenameBranchInputSchema = z.object({
	project: z.string(),
	oldBranch: z.string(),
	newBranch: z.string(),
});
export type RenameBranchInput = z.infer<typeof RenameBranchInputSchema>;

export const ApplyFixesInputSchema = z.object({
	project: z.string(),
	branch: z.string(),
	prNumber: z.number(),
});
export type ApplyFixesInput = z.infer<typeof ApplyFixesInputSchema>;

export const RebaseLocalInputSchema = z.object({
	project: z.string(),
	branch: z.string(),
});
export type RebaseLocalInput = z.infer<typeof RebaseLocalInputSchema>;

// --- Work item types (each represents a distinct kind of work) ---

const FailedCheckSchema = z.object({name: z.string(), url: z.string().optional()});

// A bare commit with no branch (detached HEAD situations)
export const CommitItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	date: z.string(),
	skippable: z.boolean(),
	suggestedBranch: z.string().optional(),
	testStatus: TestStatusSchema,
	failureTail: z.string().optional(),
});
export type CommitItem = z.infer<typeof CommitItemSchema>;

// A named branch pointing at a commit (may be local-only or pushed to remote)
export const BranchItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	date: z.string(),
	branch: z.string(),
	suggestedBranch: z.string().optional(),
	skippable: z.boolean(),
	pushedToRemote: z.boolean(),
	needsRebase: z.boolean().optional(),
	testStatus: TestStatusSchema,
	failureTail: z.string().optional(),
	blockReason: z.string().optional(),
	blockCommand: z.string().optional(),
	commitsBehind: z.number().optional(),
	commitsAhead: z.number().optional(),
	rebaseable: z.boolean().optional(),
});
export type BranchItem = z.infer<typeof BranchItemSchema>;

// A branch with an open pull request on GitHub
export const PullRequestItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	date: z.string(),
	branch: z.string(),
	skippable: z.boolean(),
	pushedToRemote: z.literal(true),
	needsRebase: z.boolean().optional(),
	testStatus: TestStatusSchema,
	failureTail: z.string().optional(),
	commitsBehind: z.number().optional(),
	commitsAhead: z.number().optional(),
	rebaseable: z.boolean().optional(),
	prUrl: z.string(),
	prNumber: z.number(),
	reviewStatus: ReviewStatusSchema,
	checkStatus: CheckStatusSchema,
	failedChecks: z.array(FailedCheckSchema).optional(),
});
export type PullRequestItem = z.infer<typeof PullRequestItemSchema>;

const LabelSchema = z.object({name: z.string(), color: z.string()});

// A GitHub issue assigned to me
export const IssueItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	url: z.string(),
	number: z.number(),
	title: z.string(),
	labels: z.array(LabelSchema),
});
export type IssueItem = z.infer<typeof IssueItemSchema>;

// An item from a GitHub Project board
export const ProjectBoardItemSchema = z.object({
	project: z.string(),
	remote: z.string(),
	url: z.string().optional(),
	number: z.number().optional(),
	title: z.string(),
	status: z.string(),
	type: z.enum(['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE']),
	labels: z.array(LabelSchema),
});
export type ProjectBoardItem = z.infer<typeof ProjectBoardItemSchema>;

// A task from a todo.md file
export const TodoItemSchema = z.object({
	project: z.string(),
	title: z.string(),
	sourceFile: z.string(),
	sourceLabel: z.string(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

// Git item union (commit, branch, or PR — used for classification)
export type GitItem = CommitItem | BranchItem | PullRequestItem;

export const ActionResultSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
	compareUrl: z.string().optional(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const SnoozedChildSchema = z.object({
	sha: z.string(),
	project: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	until: z.string().nullable(),
});
export type SnoozedChild = z.infer<typeof SnoozedChildSchema>;

// Server function input schemas
export const PushChildInputSchema = z.object({
	project: z.string(),
	sha: z.string(),
	branch: z.string().optional(),
});
export type PushChildInput = z.infer<typeof PushChildInputSchema>;

export const TestChildInputSchema = z.object({
	project: z.string(),
	sha: z.string(),
});
export type TestChildInput = z.infer<typeof TestChildInputSchema>;

export const SnoozeChildInputSchema = z.object({
	project: z.string(),
	sha: z.string(),
	until: z.string().nullable(),
});
export type SnoozeChildInput = z.infer<typeof SnoozeChildInputSchema>;

export const UnsnoozeChildInputSchema = z.object({
	sha: z.string(),
	project: z.string(),
});
export type UnsnoozeChildInput = z.infer<typeof UnsnoozeChildInputSchema>;

export const CancelTestInputSchema = z.object({
	id: z.string(),
});
export type CancelTestInput = z.infer<typeof CancelTestInputSchema>;

export const CreatePrInputSchema = z.object({
	project: z.string(),
	branch: z.string(),
	title: z.string(),
	body: z.string().optional(),
	draft: z.boolean().optional(),
});
export type CreatePrInput = z.infer<typeof CreatePrInputSchema>;

export const RefreshChildInputSchema = z.object({
	project: z.string(),
	sha: z.string(),
});
export type RefreshChildInput = z.infer<typeof RefreshChildInputSchema>;

export const RebasePrInputSchema = z.object({
	project: z.string(),
	prUrl: z.string(),
});
export type RebasePrInput = z.infer<typeof RebasePrInputSchema>;

export const CreateBranchInputSchema = z.object({
	project: z.string(),
	sha: z.string(),
	branchName: z.string(),
});
export type CreateBranchInput = z.infer<typeof CreateBranchInputSchema>;
