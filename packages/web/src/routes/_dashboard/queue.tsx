import {createFileRoute, Outlet, Link} from "@tanstack/react-router";
import {useQuery, useSuspenseQuery} from "@tanstack/react-query";
import {ClipboardList} from "../../components/icons.js";
import {useState, useMemo, useCallback, useEffect} from "react";
import {landFastForward, mergePr, runEscapeHatch, topUpReadyBuffer} from "../../lib/server-fns";
import {BulkActions} from "../../components/bulk-actions";
import {projectsQueryOptions, readyToLandQueryOptions, systemStatusQueryOptions} from "../../lib/queries";
import {ReadyToLandSection} from "../../components/ready-to-land-section";
import {pushToast} from "../../lib/toast-store";
import type {ReadyToLandItem} from "@wip/shared/ready-to-land.js";
import type {GitChildResult} from "@wip/shared/schemas.js";
import {useWorkItems} from "../../lib/use-work-items";
import type {ColumnItems} from "../../components/kanban-column";
import {QueueContext, bucketCount, type QueueContextValue} from "../../lib/queue-context";
import {SystemStatus} from "../../components/system-status";
import {FlowStrip} from "../../components/flow-strip";
import {flowCounts} from "@wip/shared/flow-counts.js";
import {CategoryBadge} from "../../components/category-badge";
import {classifyGitChild, classifyIssue, classifyTodo} from "@wip/shared/classify.js";
import {sidebarProjects} from "../../lib/sidebar-projects";
import type {Category} from "@wip/shared";
import {CATEGORIES, CATEGORY_PRIORITY, CATEGORY_PRIORITY_REVERSED, categoryDotClass} from "../../lib/category-actions";

const MAX_VISIBLE_PROJECTS = 8;

export const Route = createFileRoute("/_dashboard/queue")({
	head: () => ({
		meta: [{title: "WIP Queue"}],
	}),
	component: QueueLayout,
});

function QueueLayout() {
	const {data: projects} = useSuspenseQuery(projectsQueryOptions());
	const workItems = useWorkItems(projects);
	const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
	const [selectedProject, setSelectedProject] = useState<string | null>(null);

	const {grouped, totalCount, readyToTestCount, needsRebaseCount} = useMemo(() => {
		const g: Record<Category, ColumnItems> = {
			upstream_red: {},
			untriaged: {},
			triaged: {},
			blocked: {},
			skippable: {},
			snoozed: {},
			no_test: {},
			detached_head: {},
			local_changes: {},
			ready_to_test: {},
			test_running: {},
			test_failed: {},
			needs_rebase: {},
			rebase_unknown: {},
			rebase_conflicts: {},
			rebase_stuck: {},
			ready_to_push: {},
			pushing: {},
			pushed_no_pr: {},
			checks_unknown: {},
			checks_running: {},
			checks_failed: {},
			checks_passed: {},
			review_comments: {},
			changes_requested: {},
			approved: {},
			landed: {},
		};

		const projectMap = new Map(projects.map((p) => [p.name, p]));

		for (const child of workItems.gitChildren) {
			const p = projectMap.get(child.project);
			if (!p) continue;
			const cat = classifyGitChild(child, p);
			g[cat].gitChildren = g[cat].gitChildren ?? [];
			g[cat].gitChildren.push(child);
		}

		for (const issue of workItems.issues) {
			const cat = classifyIssue(issue);
			g[cat].issues = g[cat].issues ?? [];
			g[cat].issues.push(issue);
		}

		for (const todo of workItems.todos) {
			const cat = classifyTodo(todo);
			g[cat].todos = g[cat].todos ?? [];
			g[cat].todos.push(todo);
		}

		g.untriaged.projectItems = workItems.projectItems;

		// On hold and snoozed items are not WIP.
		let total = 0;
		for (const cat of CATEGORY_PRIORITY) {
			if (cat !== "snoozed") total += bucketCount(g[cat]);
		}

		const rtCount = g.ready_to_test.gitChildren?.length ?? 0;
		const nrCount = g.needs_rebase.gitChildren?.filter((c) => c.branch !== undefined).length ?? 0;

		return {grouped: g, totalCount: total, readyToTestCount: rtCount, needsRebaseCount: nrCount};
	}, [workItems, projects]);

	const {data: systemStatus} = useQuery(systemStatusQueryOptions());
	const {data: readyToLand} = useQuery(readyToLandQueryOptions());
	// Ages come from the client clock, set after mount so hydration matches the server render.
	const [now, setNow] = useState<number | null>(null);
	useEffect(() => {
		const tick = () => {
			setNow(Date.now());
		};
		const first = setTimeout(tick, 0);
		const timer = setInterval(tick, 60_000);
		return () => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, []);
	const land = useCallback((item: ReadyToLandItem, commit: GitChildResult | undefined) => {
		const landing =
			item.landing === "pull-request"
				? commit?.prNumber === undefined
					? null
					: mergePr({data: {project: item.project, prNumber: commit.prNumber}})
				: landFastForward({data: {project: item.project, sha: item.sha}});
		void landing?.then((result) => {
			pushToast({level: result.ok ? "success" : "error", message: result.message});
			return undefined;
		});
	}, []);
	const readySlots = systemStatus?.readySlots;
	const counts = useMemo(
		() => flowCounts({projects, gitChildren: workItems.gitChildren, todos: workItems.todos, slots: readySlots}),
		[projects, workItems, readySlots],
	);

	const {categoryCounts, projectCounts} = useMemo(() => {
		const catCounts: Partial<Record<Category, number>> = {};
		const projCounts = new Map<string, number>();

		for (const cat of CATEGORY_PRIORITY) {
			const items = grouped[cat];
			const count = bucketCount(items);

			if (count > 0) {
				catCounts[cat] = count;
			}

			for (const child of items.gitChildren ?? []) {
				projCounts.set(child.project, (projCounts.get(child.project) ?? 0) + 1);
			}
			for (const issue of items.issues ?? []) {
				const issueName = issue.repository.name;
				projCounts.set(issueName, (projCounts.get(issueName) ?? 0) + 1);
			}
			for (const item of items.projectItems ?? []) {
				projCounts.set(item.project, (projCounts.get(item.project) ?? 0) + 1);
			}
			for (const todo of items.todos ?? []) {
				projCounts.set(todo.project, (projCounts.get(todo.project) ?? 0) + 1);
			}
		}

		return {categoryCounts: catCounts, projectCounts: projCounts};
	}, [grouped]);

	const filterByProject = useCallback(
		(items: ColumnItems): ColumnItems => {
			if (!selectedProject) return items;
			return {
				gitChildren: items.gitChildren?.filter((c) => c.project === selectedProject),
				issues: items.issues?.filter((i) => i.repository.name === selectedProject),
				projectItems: items.projectItems?.filter((p) => p.project === selectedProject),
				todos: items.todos?.filter((t) => t.project === selectedProject),
			};
		},
		[selectedProject],
	);

	const handleCategoryClick = (category: Category | null) => {
		setSelectedCategory((previous) => (previous === category ? null : category));
	};

	const handleProjectClick = (project: string | null) => {
		setSelectedProject((previous) => (previous === project ? null : project));
	};

	const visibleCategories = useMemo(
		() => (selectedCategory ? [selectedCategory] : CATEGORY_PRIORITY_REVERSED),
		[selectedCategory],
	);

	const [showAllProjects, setShowAllProjects] = useState(false);
	const {visible: visibleProjects, hiddenCount: hiddenProjectCount} = useMemo(
		() => sidebarProjects(projectCounts, projects, MAX_VISIBLE_PROJECTS, showAllProjects),
		[projectCounts, projects, showAllProjects],
	);

	const queueContextValue = useMemo<QueueContextValue>(
		() => ({
			grouped,
			totalCount,
			readyToTestCount,
			needsRebaseCount,
			projectCount: workItems.projectCount,
			selectedCategory,
			selectedProject,
			filterByProject,
			visibleCategories,
		}),
		[
			grouped,
			totalCount,
			readyToTestCount,
			needsRebaseCount,
			workItems.projectCount,
			selectedCategory,
			selectedProject,
			filterByProject,
			visibleCategories,
		],
	);

	return (
		<QueueContext.Provider value={queueContextValue}>
			<div className="grid min-h-0 md:grid-cols-[240px_1fr]">
				{/* Sidebar */}
				<aside className="border-b border-border-300 bg-bg-100 p-5 md:overflow-y-auto md:border-b-0 md:border-r">
					{/* Summary stats */}
					<section className="mb-6">
						<h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
							Summary
						</h3>
						<div className="flex flex-col">
							<div className="flex items-center justify-between border-b border-border-300 py-2 text-[0.8125rem] text-text-300">
								<span>Total items</span>
								<span className="font-semibold text-text-000">{totalCount}</span>
							</div>
							<div className="flex items-center justify-between py-2 text-[0.8125rem] text-text-300">
								<span>Projects</span>
								<span className="font-semibold text-text-000">{workItems.projectCount}</span>
							</div>
						</div>
					</section>

					{/* Category filters */}
					<section className="mb-6">
						<h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
							Categories
						</h3>
						<div className="flex flex-col gap-0.5">
							<button
								type="button"
								onClick={() => {
									handleCategoryClick(null);
								}}
								className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
									selectedCategory === null ? "bg-bg-200 font-medium" : ""
								}`}
							>
								<span className="flex items-center">
									<span className="mr-2 h-2 w-2 shrink-0 rounded-full bg-status-green" />
									All
								</span>
								<span className="min-w-6 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
									{totalCount}
								</span>
							</button>
							{CATEGORY_PRIORITY_REVERSED.map((cat) => {
								const count = categoryCounts[cat];
								if (!count) return null;
								return (
									<button
										key={cat}
										type="button"
										onClick={() => {
											handleCategoryClick(cat);
										}}
										className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
											selectedCategory === cat ? "bg-bg-200 font-medium" : ""
										}`}
									>
										<span className="flex items-center">
											<span
												className={`mr-2 h-2 w-2 shrink-0 rounded-full ${categoryDotClass(cat)}`}
											/>
											{CATEGORIES[cat].label}
										</span>
										<span className="min-w-6 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
											{count}
										</span>
									</button>
								);
							})}
						</div>
					</section>

					{/* Project filters */}
					<section>
						<h3 className="mb-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-text-500">
							Projects
						</h3>
						<div className="flex flex-col gap-0.5">
							{visibleProjects.map(({name: project, count, condition}) => (
								<button
									key={project}
									type="button"
									onClick={() => {
										handleProjectClick(project);
									}}
									className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[0.8125rem] text-text-100 transition-colors hover:bg-bg-200 ${
										selectedProject === project ? "bg-bg-200 font-medium" : ""
									}`}
								>
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="truncate">{project}</span>
										{condition && <CategoryBadge category={condition} />}
									</span>
									<span className="ml-2 min-w-6 shrink-0 rounded-full bg-bg-300 px-2 py-0.5 text-center text-xs text-text-500">
										{count}
									</span>
								</button>
							))}
							{hiddenProjectCount > 0 && !showAllProjects && (
								<button
									type="button"
									onClick={() => {
										setShowAllProjects(true);
									}}
									className="px-2 py-1.5 text-[0.8125rem] text-text-500 hover:text-text-300"
								>
									+ {hiddenProjectCount} more...
								</button>
							)}
							{showAllProjects && hiddenProjectCount > 0 && (
								<button
									type="button"
									onClick={() => {
										setShowAllProjects(false);
									}}
									className="px-2 py-1.5 text-[0.8125rem] text-text-500 hover:text-text-300"
								>
									Show less
								</button>
							)}
						</div>
					</section>
				</aside>

				{/* Main content */}
				<main className="overflow-y-auto p-6 pr-8">
					<div className="mb-6 flex items-center justify-between">
						<div>
							<h1 className="text-xl font-semibold">Queue</h1>
							<span className="text-sm text-text-500">
								{totalCount} items across {workItems.projectCount} projects
							</span>
							<FlowStrip counts={counts} />
							<SystemStatus />
						</div>
						<div className="flex items-center gap-2">
							{/* View toggle */}
							<div className="mr-2 flex rounded-lg border border-border-300">
								<Link
									to="/queue"
									activeOptions={{exact: true}}
									className="rounded-l-lg px-3 py-1.5 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 [&.active]:bg-bg-200 [&.active]:text-text-000"
								>
									Cards
								</Link>
								<Link
									to="/queue/table"
									className="rounded-r-lg border-l border-border-300 px-3 py-1.5 text-xs font-medium text-text-300 transition-colors hover:bg-bg-200 [&.active]:bg-bg-200 [&.active]:text-text-000"
								>
									Table
								</Link>
							</div>
							<Link
								to="/advance-plan"
								className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-purple-700"
							>
								<ClipboardList className="h-4 w-4" />
								Generate Advance Plan
							</Link>
							<BulkActions
								topUp={async () => topUpReadyBuffer()}
								runRecipe={async (recipe) => runEscapeHatch({data: {recipe}})}
							/>
						</div>
					</div>
					<ReadyToLandSection
						state={readyToLand}
						commits={workItems.gitChildren}
						projects={projects}
						now={now}
						onLand={land}
					/>
					<Outlet />
				</main>
			</div>
		</QueueContext.Provider>
	);
}
