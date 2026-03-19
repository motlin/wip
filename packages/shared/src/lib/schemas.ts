import {z} from 'zod';

export const ReviewStatusSchema = z.enum(['clean', 'approved', 'changes_requested', 'commented', 'no_pr']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CheckStatusSchema = z.enum(['pending', 'running', 'passed', 'failed', 'none']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const TestStatusSchema = z.enum(['passed', 'failed', 'unknown']);
export type TestStatus = z.infer<typeof TestStatusSchema>;

// Kanban left-to-right: full SDLC flow
export const CategorySchema = z.enum([
	'skippable',
	'snoozed',
	'no_test',
	'blocked',
	'ready_to_test',
	'test_failed',
	'ready_to_push',
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
	reviewStatus: ReviewStatusSchema,
});
export type ChildCommit = z.infer<typeof ChildCommitSchema>;

export const ClassifiedChildSchema = z.object({
	project: z.string(),
	projectDir: z.string(),
	upstreamRemote: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	date: z.string(),
	branch: z.string().optional(),
	suggestedBranch: z.string().optional(),
	category: CategorySchema,
});
export type ClassifiedChild = z.infer<typeof ClassifiedChildSchema>;

export const ReportDataSchema = z.object({
	projects: z.number(),
	children: z.number(),
	snoozedCount: z.number(),
	grouped: z.record(CategorySchema, z.array(ClassifiedChildSchema)),
});
export type ReportData = z.infer<typeof ReportDataSchema>;

export const ActionResultSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const SnoozedChildSchema = z.object({
	sha: z.string(),
	project: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	until: z.string().nullable(),
	systemFrom: z.string(),
	systemTo: z.string(),
});
export type SnoozedChild = z.infer<typeof SnoozedChildSchema>;

// Server function input schemas
export const PushChildInputSchema = z.object({
	projectDir: z.string(),
	upstreamRemote: z.string(),
	sha: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	branch: z.string().optional(),
});
export type PushChildInput = z.infer<typeof PushChildInputSchema>;

export const TestChildInputSchema = z.object({
	project: z.string(),
	projectDir: z.string(),
	sha: z.string(),
	shortSha: z.string(),
});
export type TestChildInput = z.infer<typeof TestChildInputSchema>;

export const SnoozeChildInputSchema = z.object({
	sha: z.string(),
	project: z.string(),
	shortSha: z.string(),
	subject: z.string(),
	until: z.string().nullable(),
});
export type SnoozeChildInput = z.infer<typeof SnoozeChildInputSchema>;

export const UnsnoozeChildInputSchema = z.object({
	sha: z.string(),
	project: z.string(),
});
export type UnsnoozeChildInput = z.infer<typeof UnsnoozeChildInputSchema>;
