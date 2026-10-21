import {createFileRoute, Link} from "@tanstack/react-router";
import {useSuspenseQuery} from "@tanstack/react-query";
import {useState} from "react";
import {ArrowLeft, Clock, RefreshCw} from "lucide-react";
import {advancePlanQueryOptions} from "../lib/queries.js";
import {rebaseChild, runClaudeCommand, testChild} from "../lib/server-fns.js";
import type {AdvancePlanBranchSummary, AdvancePlanProjectSummary, TestJobStatus} from "../lib/server-fns.js";
import {useAllTasks, type TaskEvent} from "../lib/server-events-context.js";
import {
	ProjectSection,
	actionKey,
	type ActionMessage,
	type BranchAction,
} from "../components/advance-plan-project-section.js";

export const Route = createFileRoute("/advance-plan")({
	loader: async ({context: {queryClient}}) => queryClient.query({...advancePlanQueryOptions(), staleTime: "static"}),
	head: () => ({
		meta: [{title: "WIP Advance Plan"}],
	}),
	component: AdvancePlanPage,
});

function formatGeneratedAt(generatedAt: number): string {
	return new Date(generatedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
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

	const runBaselineTest = async (project: AdvancePlanProjectSummary) => {
		const key = `${project.project}:baseline`;
		setPendingAction(key);
		try {
			if (!project.baselineSha) throw new Error("Baseline commit is unknown; refresh the plan");
			const result = await testChild({data: {project: project.project, sha: project.baselineSha}});
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
						onClick={() => {
							void refreshPlan();
						}}
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
					runBaselineTest={runBaselineTest}
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
	runBaselineTest,
}: {
	title: string;
	projects: AdvancePlanProjectSummary[];
	emptyText: string;
	getTask?: (sha: string, project: string) => TaskEvent | undefined;
	messages?: Record<string, ActionMessage>;
	pendingAction?: string | null;
	runBranchAction?: (branch: AdvancePlanBranchSummary, action: BranchAction) => Promise<void>;
	runBaselineTest?: (project: AdvancePlanProjectSummary) => Promise<void>;
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
							runBaselineTest={runBaselineTest}
						/>
					))}
				</div>
			)}
		</section>
	);
}
