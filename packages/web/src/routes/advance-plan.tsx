import {createFileRoute, Link} from "@tanstack/react-router";
import {useSuspenseQuery} from "@tanstack/react-query";
import {useState} from "react";
import {
	ArrowLeft,
	Bot,
	CheckCircle,
	Clock,
	FlaskConical,
	GitBranch,
	GitMerge,
	Loader2,
	RefreshCw,
	Wrench,
	XCircle,
} from "lucide-react";
import {advancePlanQueryOptions} from "../lib/queries";
import {rebaseChild, runClaudeCommand, testChild} from "../lib/server-fns";
import type {AdvancePlanBranchSummary, AdvancePlanProjectSummary, TestJobStatus} from "../lib/server-fns";
import {useAllTasks, type TaskEvent} from "../lib/server-events-context";

export const Route = createFileRoute("/advance-plan")({
	loader: ({context: {queryClient}}) => queryClient.ensureQueryData(advancePlanQueryOptions()),
	head: () => ({
		meta: [{title: "WIP Advance Plan"}],
	}),
	component: AdvancePlanPage,
});

type BranchAction = "test" | "rebase" | "resolve-conflicts" | "fix-failure";

interface ActionMessage {
	level: "success" | "error";
	text: string;
}

function formatGeneratedAt(generatedAt: number): string {
	return new Date(generatedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
}

function statusClass(status: AdvancePlanProjectSummary["status"]): string {
	switch (status) {
		case "ready":
			return "border-status-green/40 bg-status-green/10 text-status-green";
		case "skipped":
			return "border-status-red/40 bg-status-red/10 text-status-red";
		case "noop":
			return "border-border-300/50 bg-bg-200 text-text-400";
	}
}

function taskStatusIcon(status: TaskEvent["status"]) {
	switch (status) {
		case "queued":
			return <Clock className="h-3.5 w-3.5 text-text-400" />;
		case "running":
			return <Loader2 className="h-3.5 w-3.5 animate-spin text-status-yellow" />;
		case "passed":
			return <CheckCircle className="h-3.5 w-3.5 text-status-green" />;
		case "failed":
			return <XCircle className="h-3.5 w-3.5 text-status-red" />;
		case "cancelled":
			return <XCircle className="h-3.5 w-3.5 text-text-500" />;
	}
}

function actionIcon(action: BranchAction) {
	switch (action) {
		case "test":
			return <FlaskConical className="h-3.5 w-3.5" />;
		case "rebase":
			return <GitMerge className="h-3.5 w-3.5" />;
		case "resolve-conflicts":
			return <Bot className="h-3.5 w-3.5" />;
		case "fix-failure":
			return <Wrench className="h-3.5 w-3.5" />;
	}
}

function actionLabel(action: BranchAction): string {
	switch (action) {
		case "test":
			return "Run Tests";
		case "rebase":
			return "Rebase";
		case "resolve-conflicts":
			return "Resolve";
		case "fix-failure":
			return "Fix";
	}
}

function actionKey(branch: AdvancePlanBranchSummary, action: BranchAction): string {
	return `${branch.project}:${branch.branch}:${action}`;
}

function taskMessage(result: TestJobStatus): string {
	return `Task ${result.id} ${result.status}${result.message ? `: ${result.message}` : ""}`;
}

function AdvancePlanPage() {
	const query = useSuspenseQuery(advancePlanQueryOptions());
	const {getTask} = useAllTasks();
	const [refreshing, setRefreshing] = useState(false);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [messages, setMessages] = useState<Record<string, ActionMessage>>({});

	const readyProjects = query.data.projects.filter((project) => project.status === "ready");
	const skippedProjects = query.data.projects.filter((project) => project.status === "skipped");
	const noopProjects = query.data.projects.filter((project) => project.status === "noop");
	const branchCount = readyProjects.reduce((sum, project) => sum + project.branches.length, 0);

	const refreshPlan = async () => {
		setRefreshing(true);
		await query.refetch();
		setRefreshing(false);
	};

	const runBranchAction = async (branch: AdvancePlanBranchSummary, action: BranchAction) => {
		const key = actionKey(branch, action);
		setPendingAction(key);
		try {
			let result: TestJobStatus;
			switch (action) {
				case "test":
					result = await testChild({data: {project: branch.project, sha: branch.tipSha}});
					break;
				case "rebase":
					result = await rebaseChild({data: {project: branch.project, branch: branch.branch}});
					break;
				case "resolve-conflicts":
					result = await runClaudeCommand({
						data: {
							project: branch.project,
							sha: branch.tipSha,
							branch: branch.branch,
							command: "/git:conflicts",
						},
					});
					break;
				case "fix-failure":
					result = await runClaudeCommand({
						data: {
							project: branch.project,
							sha: branch.tipSha,
							branch: branch.branch,
							command: "/build:fix",
						},
					});
					break;
			}
			setMessages((previous) => ({...previous, [key]: {level: "success", text: taskMessage(result)}}));
		} catch (error) {
			setMessages((previous) => ({
				...previous,
				[key]: {level: "error", text: error instanceof Error ? error.message : "Action failed"},
			}));
		} finally {
			setPendingAction(null);
		}
	};

	return (
		<div className="mx-auto max-w-7xl p-6">
			<div className="mb-5 flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="mb-2">
						<Link
							to="/queue"
							className="inline-flex items-center gap-1 text-sm text-text-500 transition-colors hover:text-text-200"
						>
							<ArrowLeft className="h-3.5 w-3.5" />
							Queue
						</Link>
					</div>
					<h1 className="text-xl font-semibold text-text-000">Advance Plan</h1>
					<p className="text-sm text-text-500">
						Generated at {formatGeneratedAt(query.data.generatedAt)}. {branchCount} branch
						{branchCount === 1 ? "" : "es"} across {readyProjects.length} ready project
						{readyProjects.length === 1 ? "" : "s"}.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Link
						to="/tasks"
						className="inline-flex items-center gap-1.5 rounded-lg border border-border-300 px-3 py-1.5 text-sm font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100"
					>
						<Clock className="h-4 w-4" />
						Tasks
					</Link>
					<button
						type="button"
						onClick={refreshPlan}
						disabled={refreshing}
						className="inline-flex items-center gap-1.5 rounded-lg border border-border-300 bg-bg-000 px-3 py-1.5 text-sm font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:opacity-60"
					>
						<RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
						{refreshing ? "Refreshing..." : "Refresh Plan"}
					</button>
				</div>
			</div>

			<div className="mb-5 grid gap-2 sm:grid-cols-3">
				<SummaryTile label="Ready" value={readyProjects.length} detail={`${branchCount} branches`} />
				<SummaryTile label="Skipped" value={skippedProjects.length} detail="Needs manual cleanup" />
				<SummaryTile label="Noop" value={noopProjects.length} detail="Nothing to advance" />
			</div>

			<div className="space-y-6">
				<ProjectGroup
					title="Ready"
					projects={readyProjects}
					emptyText="No ready projects in this plan."
					getTask={getTask}
					messages={messages}
					pendingAction={pendingAction}
					runBranchAction={runBranchAction}
				/>
				<ProjectGroup title="Skipped" projects={skippedProjects} emptyText="No skipped projects." />
				<ProjectGroup title="No Changes" projects={noopProjects} emptyText="No no-op projects." />
			</div>
		</div>
	);
}

function SummaryTile({label, value, detail}: {label: string; value: number; detail: string}) {
	return (
		<div className="rounded-lg border border-border-300/40 bg-bg-000 px-3 py-2">
			<div className="text-xs font-medium text-text-500">{label}</div>
			<div className="mt-1 flex items-baseline gap-2">
				<span className="text-xl font-semibold text-text-000">{value}</span>
				<span className="text-sm text-text-500">{detail}</span>
			</div>
		</div>
	);
}

function ProjectGroup({
	title,
	projects,
	emptyText,
	getTask,
	messages,
	pendingAction,
	runBranchAction,
}: {
	title: string;
	projects: AdvancePlanProjectSummary[];
	emptyText: string;
	getTask?: (sha: string, project: string) => TaskEvent | undefined;
	messages?: Record<string, ActionMessage>;
	pendingAction?: string | null;
	runBranchAction?: (branch: AdvancePlanBranchSummary, action: BranchAction) => Promise<void>;
}) {
	return (
		<section>
			<div className="mb-2 flex items-center gap-2">
				<h2 className="text-sm font-semibold text-text-200">{title}</h2>
				<span className="text-xs text-text-500">{projects.length}</span>
			</div>
			{projects.length === 0 ? (
				<p className="rounded-lg border border-border-300/30 bg-bg-000 px-3 py-2 text-sm text-text-500">
					{emptyText}
				</p>
			) : (
				<div className="space-y-3">
					{projects.map((project) => (
						<ProjectSection
							key={project.project}
							project={project}
							getTask={getTask}
							messages={messages}
							pendingAction={pendingAction}
							runBranchAction={runBranchAction}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function ProjectSection({
	project,
	getTask,
	messages,
	pendingAction,
	runBranchAction,
}: {
	project: AdvancePlanProjectSummary;
	getTask?: (sha: string, project: string) => TaskEvent | undefined;
	messages?: Record<string, ActionMessage>;
	pendingAction?: string | null;
	runBranchAction?: (branch: AdvancePlanBranchSummary, action: BranchAction) => Promise<void>;
}) {
	return (
		<div className="rounded-lg border border-border-300/40 bg-bg-000">
			<div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-300/30 px-3 py-2.5">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="font-medium text-text-000">{project.project}</h3>
						<span
							className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(project.status)}`}
						>
							{project.status}
						</span>
						{project.detail && <span className="text-xs text-text-500">{project.detail}</span>}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-500">
						<span>{project.upstreamRef}</span>
						<span>Concurrency {project.concurrency}</span>
						<span>{project.baselineNeedsTest ? "Baseline needs test" : "Baseline cached green"}</span>
					</div>
				</div>
				<span className="text-xs text-text-500">
					{project.branches.length} branch{project.branches.length === 1 ? "" : "es"}
				</span>
			</div>
			{project.branches.length > 0 ? (
				<div className="divide-y divide-border-300/30">
					{project.branches.map((branch) => (
						<BranchRow
							key={`${branch.project}:${branch.branch}`}
							branch={branch}
							task={getTask?.(branch.tipSha, branch.project)}
							messages={messages}
							pendingAction={pendingAction}
							runBranchAction={runBranchAction}
						/>
					))}
				</div>
			) : (
				<div className="px-3 py-2 text-sm text-text-500">
					{project.status === "noop" ? "No branch work remains." : "No branch actions available."}
				</div>
			)}
		</div>
	);
}

function BranchRow({
	branch,
	task,
	messages,
	pendingAction,
	runBranchAction,
}: {
	branch: AdvancePlanBranchSummary;
	task?: TaskEvent;
	messages?: Record<string, ActionMessage>;
	pendingAction?: string | null;
	runBranchAction?: (branch: AdvancePlanBranchSummary, action: BranchAction) => Promise<void>;
}) {
	const actions: BranchAction[] = ["test", "rebase", "resolve-conflicts", "fix-failure"];

	return (
		<div className="grid gap-3 px-3 py-2.5 lg:grid-cols-[minmax(0,1fr)_auto]">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<span className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-text-100">
						<GitBranch className="h-3.5 w-3.5 shrink-0 text-text-500" />
						<span className="truncate">{branch.branch}</span>
					</span>
					<span className="font-mono text-xs text-text-500">{branch.shortSha}</span>
					<span className="text-xs text-text-500">
						{branch.ownedCommitCount} owned commit{branch.ownedCommitCount === 1 ? "" : "s"}
					</span>
					{branch.worktreeRequired && (
						<span className="rounded bg-bg-200 px-1.5 py-0.5 text-xs text-text-500">worktree</span>
					)}
					{task && (
						<span className="inline-flex items-center gap-1 rounded bg-bg-200 px-1.5 py-0.5 text-xs text-text-400">
							{taskStatusIcon(task.status)}
							{task.taskType} {task.status}
						</span>
					)}
				</div>
				<div className="mt-1 flex flex-wrap gap-2 text-xs text-text-500">
					<span>Depends on {branch.dependsOn.length === 0 ? "nothing" : branch.dependsOn.join(", ")}</span>
					<span>Expected: {branch.expectedActions.map(actionLabel).join(", ")}</span>
				</div>
				{messages &&
					actions.map((action) => {
						const message = messages[actionKey(branch, action)];
						if (!message) return null;
						return (
							<p
								key={action}
								className={`mt-1 text-xs ${
									message.level === "success" ? "text-status-green" : "text-status-red"
								}`}
							>
								{message.text}
							</p>
						);
					})}
			</div>
			<div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
				{actions.map((action) => {
					const key = actionKey(branch, action);
					const pending = pendingAction === key;
					return (
						<button
							key={action}
							type="button"
							onClick={() => void runBranchAction?.(branch, action)}
							disabled={!runBranchAction || pending}
							className="inline-flex items-center gap-1 rounded-md border border-border-300/50 px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:opacity-60"
							title={actionLabel(action)}
						>
							{pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : actionIcon(action)}
							{actionLabel(action)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
