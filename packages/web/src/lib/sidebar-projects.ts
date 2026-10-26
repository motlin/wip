import {type Category, type ProjectInfo, projectCondition} from "@wip/shared";

export interface SidebarProject {
	name: string;
	count: number;
	condition: Category | undefined;
}

// Projects with items sort by count; a flagged project (dirty, detached, mid-rebase) is work in progress,
// so it always appears with its chip, even with no items and past the collapsed limit.
export function sidebarProjects(
	counts: ReadonlyMap<string, number>,
	projects: readonly ProjectInfo[],
	max: number,
	showAll: boolean,
): {visible: SidebarProject[]; hiddenCount: number} {
	const conditions = new Map(projects.map((p) => [p.name, projectCondition(p)]));
	const all: SidebarProject[] = [...counts.entries()]
		.map(([name, count]) => ({name, count, condition: conditions.get(name)}))
		.toSorted((a, b) => b.count - a.count);
	for (const [name, condition] of conditions) {
		if (condition && !counts.has(name)) all.push({name, count: 0, condition});
	}
	const collapsed = all.filter((entry, index) => index < max || entry.condition !== undefined);
	return {visible: showAll ? all : collapsed, hiddenCount: all.length - collapsed.length};
}
