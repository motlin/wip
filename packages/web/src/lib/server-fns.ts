import {createServerFn} from "@tanstack/react-start";
import {z} from "zod";
import {
	ApplyFixesInputSchema,
	CancelTestInputSchema,
	CreateBranchInputSchema,
	CreatePrInputSchema,
	DeleteBranchInputSchema,
	ForcePushInputSchema,
	MergePrInputSchema,
	PushChildInputSchema,
	RebaseLocalInputSchema,
	RefreshChildInputSchema,
	RenameBranchInputSchema,
	RunClaudeCommandInputSchema,
	SnoozeChildInputSchema,
	TestChildInputSchema,
	UnsnoozeChildInputSchema,
} from "@wip/shared/schemas.js";
import type {
	AdvancePlanSummary,
	FileDiff,
	GenerateAdvancePlanInput,
	ProjectChildrenResult,
	RunAllCounts,
	SystemStatus,
	TestJobStatus,
} from "./server-fns.impl.js";
import type {GitHubProjectItem, IssueResult, ProjectItemResult} from "@wip/shared";
import type {ActionResult, SnoozedChild, TaskQueueJob} from "@wip/shared/schemas.js";

export type {
	AdvancePlanBranchSummary,
	AdvancePlanProjectSummary,
	FileDiff,
	ProjectChildrenResult,
	TestJobStatus,
} from "./server-fns.impl.js";
export type {SnoozedChild} from "@wip/shared/schemas.js";

const serverFns: () => Promise<typeof import("./server-fns.impl.js")> = import.meta.env.SSR
	? () => import("./server-fns.impl.js")
	: async () => {
			throw new Error("server-fns.impl is only available during SSR");
		};

export const getProjects = createServerFn({method: "GET"}).handler(async () =>
	(await serverFns()).getProjectsHandler(),
);

export const getProjectChildren = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<ProjectChildrenResult> => (await serverFns()).getProjectChildrenHandler(data.project),
	);

export const getProjectTodos = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}) => (await serverFns()).getProjectTodosHandler(data.project));

export const getIssues = createServerFn({method: "GET"}).handler(async () => (await serverFns()).getIssuesHandler());

export const getProjectItemsFn = createServerFn({method: "GET"}).handler(
	async (): Promise<GitHubProjectItem[]> => (await serverFns()).getProjectItemsHandler(),
);

export const getIssueByNumber = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), number: z.number()}).parse(input))
	.handler(async ({data}): Promise<IssueResult | null> => (await serverFns()).getIssueByNumberHandler(data));

export const getProjectItemByNumber = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), number: z.number()}).parse(input))
	.handler(
		async ({data}): Promise<ProjectItemResult | null> => (await serverFns()).getProjectItemByNumberHandler(data),
	);

export const pushChild = createServerFn({method: "POST"})
	.validator((input: unknown) => PushChildInputSchema.parse(input))
	.handler(async ({data}): Promise<TestJobStatus> => (await serverFns()).pushChildHandler(data));

export const createPr = createServerFn({method: "POST"})
	.validator((input: unknown) => CreatePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).createPrHandler(data));

export const testChild = createServerFn({method: "POST"})
	.validator((input: unknown) => TestChildInputSchema.parse(input))
	.handler(async ({data}): Promise<TestJobStatus> => (await serverFns()).testChildHandler(data));

export const testAllChildren = createServerFn({method: "POST"}).handler(async () => {
	(await serverFns()).launchTestAllChildren();
	return {started: true} as const;
});

export const getCommitDiff = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{files: FileDiff[]; stat: string; subject: string}> =>
			(await serverFns()).getCommitDiffHandler(data),
	);

export const getWorkingTreeDiff = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{files: FileDiff[]; stat: string}> =>
			(await serverFns()).getWorkingTreeDiffHandler(data.project),
	);

export const commitWorkingTree = createServerFn({method: "POST"})
	.validator((input: unknown) => z.object({project: z.string()}).parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).commitWorkingTreeHandler(data.project));

export const getTestLog = createServerFn({method: "GET"})
	.validator((input: unknown) => z.object({project: z.string(), sha: z.string()}).parse(input))
	.handler(
		async ({data}): Promise<{log: string | null; tail: string | null}> =>
			(await serverFns()).getTestLogHandler(data),
	);

export const snoozeChildFn = createServerFn({method: "POST"})
	.validator((input: unknown) => SnoozeChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).snoozeChildHandler(data));

export const unsnoozeChildFn = createServerFn({method: "POST"})
	.validator((input: unknown) => UnsnoozeChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).unsnoozeChildHandler(data));

export const getSnoozedList = createServerFn({method: "GET"}).handler(
	async (): Promise<SnoozedChild[]> => (await serverFns()).getSnoozedListHandler(),
);

export const getTaskQueue = createServerFn({method: "GET"}).handler(
	async (): Promise<TaskQueueJob[]> => (await serverFns()).getTaskQueueHandler(),
);

export const cancelTestFn = createServerFn({method: "POST"})
	.validator((input: unknown) => CancelTestInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).cancelTestHandler(data.id));

export const runClaudeCommand = createServerFn({method: "POST"})
	.validator((input: unknown) => RunClaudeCommandInputSchema.parse(input))
	.handler(async ({data}): Promise<TestJobStatus> => (await serverFns()).runClaudeCommandHandler(data));

export const refreshChild = createServerFn({method: "POST"})
	.validator((input: unknown) => RefreshChildInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).refreshChildHandler(data.project));

export const createBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => CreateBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).createBranchHandler(data));

export const deleteBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => DeleteBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).deleteBranchHandler(data));

export const forcePush = createServerFn({method: "POST"})
	.validator((input: unknown) => ForcePushInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).forcePushHandler(data));

export const mergePr = createServerFn({method: "POST"})
	.validator((input: unknown) => MergePrInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).mergePrHandler(data));

export const renameBranch = createServerFn({method: "POST"})
	.validator((input: unknown) => RenameBranchInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).renameBranchHandler(data));

export const applyFixes = createServerFn({method: "POST"})
	.validator((input: unknown) => ApplyFixesInputSchema.parse(input))
	.handler(async ({data}): Promise<ActionResult> => (await serverFns()).applyFixesHandler(data));

export const rebaseChild = createServerFn({method: "POST"})
	.validator((input: unknown) => RebaseLocalInputSchema.parse(input))
	.handler(async ({data}): Promise<TestJobStatus> => (await serverFns()).rebaseChildHandler(data));

export const rebaseAllChildren = createServerFn({method: "POST"}).handler(async () => {
	(await serverFns()).launchRebaseAllChildren();
	return {started: true} as const;
});

export const runAllCounts = createServerFn({method: "GET"}).handler(
	async (): Promise<RunAllCounts> => (await serverFns()).runAllCountsHandler(),
);

export const generateAdvancePlan = createServerFn({method: "POST"})
	.validator((input: unknown) =>
		z
			.object({
				include: z.array(z.string()).optional(),
				exclude: z.array(z.string()).optional(),
			})
			.parse(input ?? {}),
	)
	.handler(
		async ({data}): Promise<AdvancePlanSummary> =>
			(await serverFns()).generateAdvancePlanHandler(data as GenerateAdvancePlanInput),
	);

export const refreshAll = createServerFn({method: "POST"}).handler(
	async (): Promise<ActionResult> => (await serverFns()).refreshAllHandler(),
);

export const getSystemStatus = createServerFn({method: "GET"}).handler(
	async (): Promise<SystemStatus> => (await serverFns()).getSystemStatusHandler(),
);

export const CHILDREN_CACHE_TTL_MS = 10 * 60 * 1000;
export const TODOS_CACHE_TTL_MS = 10 * 60 * 1000;

export async function refreshProjectChildren(projectName: string): Promise<ProjectChildrenResult> {
	return (await serverFns()).refreshProjectChildren(projectName);
}

export async function refreshProjectTodos(projectName: string) {
	return (await serverFns()).refreshProjectTodos(projectName);
}
