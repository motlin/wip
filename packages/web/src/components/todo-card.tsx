import {useQueryClient} from "@tanstack/react-query";
import {useState} from "react";
import type {TodoItem, Category} from "@wip/shared";
import {CategoryBadge} from "./category-badge";
import {Bot, Loader2} from "./icons.js";
import {runTodoTask, snoozeTodoFn, unsnoozeTodoFn} from "../lib/server-fns.js";
import {primaryAction} from "../lib/category-actions.js";
import {classifyTodo} from "@wip/shared/classify.js";
import {SNOOZE_PRESETS, snoozeUntil} from "../lib/snooze-presets.js";
import {runPendingAction} from "../lib/pending-action.js";
import {pushToast} from "../lib/toast-store.js";

const MENU_ITEM = "block w-full rounded px-2 py-1 text-left text-xs text-text-300 transition-colors hover:bg-bg-200";

export function TodoCard({
	todo,
	category,
	finishFirst = false,
}: {
	todo: TodoItem;
	category?: Category;
	/** Lean plan step 49: commits are waiting, so starting this todo is secondary-styled but enabled. */
	finishFirst?: boolean;
}) {
	const queryClient = useQueryClient();
	const [moreOpen, setMoreOpen] = useState(false);
	const [queuing, setQueuing] = useState(false);
	const doTask = primaryAction(category ?? classifyTodo(todo)) === "do_task";

	/** Writes the hold flag onto this todo in the project's todos cache. */
	const setHold = (onHold: boolean) => {
		queryClient.setQueryData<TodoItem[]>(["todos", todo.project], (todos) =>
			todos?.map((t) => (t.sourceFile === todo.sourceFile && t.title === todo.title ? {...t, onHold} : t)),
		);
	};
	const key = {project: todo.project, sourceFile: todo.sourceFile, title: todo.title};

	const handleDoTask = async () => {
		await runPendingAction("Do task", setQueuing, async () => {
			const status = await runTodoTask({data: key});
			pushToast({level: "info", message: `Queued "${todo.title}"`, detail: status.message});
		});
	};
	const handleSnooze = async (hours: number | null) => {
		setMoreOpen(false);
		await runPendingAction("Snooze", undefined, async () => {
			const result = await snoozeTodoFn({data: {...key, until: snoozeUntil(hours)}});
			if (result.ok) setHold(true);
		});
	};
	const handleUnsnooze = async () => {
		setMoreOpen(false);
		await runPendingAction("Unsnooze", undefined, async () => {
			const result = await unsnoozeTodoFn({data: key});
			if (result.ok) setHold(false);
		});
	};

	return (
		<div className="rounded-lg border border-border-300/30 bg-bg-000 p-3 shadow-sm hover:shadow-md transition-shadow">
			<div className="flex items-center gap-1.5">
				<span className="truncate text-xs font-medium text-text-300">{todo.project}</span>
				<span className="text-xs text-text-300">·</span>
				<span className="truncate text-xs text-text-300">{todo.sourceLabel}</span>
				{category && <CategoryBadge category={category} />}
			</div>
			<p className="mt-1.5 text-sm leading-snug text-text-100">{todo.title}</p>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				{doTask && (
					<button
						type="button"
						data-primary="true"
						data-variant={finishFirst ? "secondary" : "primary"}
						onClick={() => {
							void handleDoTask();
						}}
						disabled={queuing}
						title={`Run claude with markdown-tasks:do-one-task on "${todo.title}" from ${todo.sourceLabel} in ${todo.project}`}
						className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
							queuing
								? "cursor-not-allowed opacity-60 text-text-300"
								: finishFirst
									? "border border-border-300 text-text-300 hover:bg-bg-200"
									: "bg-purple-600 hover:bg-purple-700 text-white"
						}`}
					>
						{queuing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
						Do this task
					</button>
				)}
				<button
					type="button"
					aria-expanded={moreOpen}
					onClick={() => {
						setMoreOpen((open) => !open);
					}}
					className="rounded px-2 py-1 text-xs font-medium text-text-400 transition-colors hover:bg-bg-200 hover:text-text-300"
				>
					More
				</button>
			</div>
			{moreOpen && (
				<div className="mt-1 w-32 rounded-lg border border-border-300/50 bg-bg-000 p-1 shadow-lg">
					{todo.onHold && (
						<button
							type="button"
							onClick={() => {
								void handleUnsnooze();
							}}
							className={MENU_ITEM}
						>
							Unsnooze
						</button>
					)}
					{SNOOZE_PRESETS.map((preset) => (
						<button
							key={preset.label}
							type="button"
							onClick={() => {
								void handleSnooze(preset.hours);
							}}
							className={MENU_ITEM}
						>
							{preset.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
