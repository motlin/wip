import {Bot, CheckCircle, Clock, FlaskConical, GitBranch, GitMerge, Loader2, Wrench, XCircle} from "./icons.js";
import type {AdvancePlanBranchSummary, AdvancePlanProjectSummary} from "../lib/server-fns.js";
import type {TaskEvent} from "../lib/server-events-context.js";

export type BranchAction = "test" | "rebase" | "resolve-conflicts" | "fix-failure";

export interface ActionMessage {
	level: "success" | "error";
	text: string;
}

const STATUS_CLASSES: Record<AdvancePlanProjectSummary["status"], string> = {
	ready: "border-status-green/40 bg-status-green/10 text-status-green",
	skipped: "border-status-red/40 bg-status-red/10 text-status-red",
	noop: "border-border-300/50 bg-bg-200 text-text-400",
};

function statusClass(status: AdvancePlanProjectSummary["status"]): string {
	return STATUS_CLASSES[status];
}

const TASK_STATUS_ICONS: Record<TaskEvent["status"], React.ReactElement> = {
	queued: <Clock className="h-3.5 w-3.5 text-text-400" />,
	running: <Loader2 className="h-3.5 w-3.5 animate-spin text-status-yellow" />,
	passed: <CheckCircle className="h-3.5 w-3.5 text-status-green" />,
	failed: <XCircle className="h-3.5 w-3.5 text-status-red" />,
	cancelled: <XCircle className="h-3.5 w-3.5 text-text-500" />,
};

function taskStatusIcon(status: TaskEvent["status"]) {
	return TASK_STATUS_ICONS[status];
}

const ACTION_ICONS: Record<BranchAction, React.ReactElement> = {
	test: <FlaskConical className="h-3.5 w-3.5" />,
	rebase: <GitMerge className="h-3.5 w-3.5" />,
	"resolve-conflicts": <Bot className="h-3.5 w-3.5" />,
	"fix-failure": <Wrench className="h-3.5 w-3.5" />,
};

function actionIcon(action: BranchAction) {
	return ACTION_ICONS[action];
}

const ACTION_LABELS: Record<BranchAction, string> = {
	test: "Run Tests",
	rebase: "Rebase",
	"resolve-conflicts": "Resolve",
	"fix-failure": "Fix",
};

function actionLabel(action: BranchAction): string {
	return ACTION_LABELS[action];
}

export function actionKey(branch: AdvancePlanBranchSummary, action: BranchAction): string {
	return `${branch.project}:${branch.branch}:${action}`;
}

export function ProjectSection({
	project,
	getTask,
	messages,
	pendingAction,
	runBranchAction,
	runBaselineTest,
}: {
	project: AdvancePlanProjectSummary;
	getTask?: (sha: string, project: string) => TaskEvent | undefined;
	messages?: Record<string, ActionMessage>;
	pendingAction?: string | null;
	runBranchAction?: (branch: AdvancePlanBranchSummary, action: BranchAction) => Promise<void>;
	runBaselineTest?: (project: AdvancePlanProjectSummary) => Promise<void>;
}) {
	const baselineKey = `${project.project}:baseline`;
	const baselinePending = pendingAction === baselineKey;
	const baselineMessage = messages?.[baselineKey];
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
						{project.status !== "skipped" && (
							<span>{project.baselineNeedsTest ? "Baseline needs test" : "Baseline cached green"}</span>
						)}
					</div>
				</div>
				<div className="flex flex-col items-end gap-1">
					<span className="text-xs text-text-500">
						{project.branches.length} branch{project.branches.length === 1 ? "" : "es"}
					</span>
					{project.baselineNeedsTest && runBaselineTest && (
						<button
							type="button"
							onClick={() => void runBaselineTest(project)}
							disabled={baselinePending}
							className="inline-flex items-center gap-1 rounded-md border border-border-300/50 px-2 py-1 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 hover:text-text-100 disabled:opacity-60"
						>
							{baselinePending ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<FlaskConical className="h-3.5 w-3.5" />
							)}
							Run Baseline Tests
						</button>
					)}
				</div>
			</div>
			{baselineMessage && (
				<p
					className={`px-3 pt-2 text-xs ${
						baselineMessage.level === "success" ? "text-status-green" : "text-status-red"
					}`}
				>
					{baselineMessage.text}
				</p>
			)}
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
					{project.status === "noop"
						? "No branch work remains."
						: project.baselineNeedsTest
							? "Run the baseline tests before branch actions are planned."
							: "No branch actions available."}
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
				{branch.expectedActions.map((action) => {
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
