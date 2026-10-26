import {describe, it, expect} from "vite-plus/test";

import type {ProjectInfo} from "@wip/shared";

import {sidebarProjects} from "./sidebar-projects.js";

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
	return {
		name: "test",
		dir: "/tmp/test",
		remote: "origin",
		originRemote: "origin",
		upstreamRemote: "origin",
		upstreamBranch: "main",
		upstreamRef: "origin/main",
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured: true,
		rebaseInProgress: false,
		...overrides,
	};
}

describe("sidebarProjects", () => {
	it("lists projects with items by count, then flagged projects with no items", () => {
		const projects = [
			makeProject({name: "busy"}),
			makeProject({name: "quiet"}),
			makeProject({name: "dirty-only", dirty: true}),
			makeProject({name: "rebasing-only", rebaseInProgress: true}),
		];
		const counts = new Map([
			["quiet", 1],
			["busy", 3],
		]);

		expect(sidebarProjects(counts, projects, 8, false)).toStrictEqual({
			visible: [
				{name: "busy", count: 3, condition: undefined},
				{name: "quiet", count: 1, condition: undefined},
				{name: "dirty-only", count: 0, condition: "local_changes"},
				{name: "rebasing-only", count: 0, condition: "rebase_stuck"},
			],
			hiddenCount: 0,
		});
	});

	it("keeps flagged projects visible past the collapsed limit", () => {
		const projects = [
			makeProject({name: "a"}),
			makeProject({name: "b"}),
			makeProject({name: "c"}),
			makeProject({name: "dirty", dirty: true}),
		];
		const counts = new Map([
			["a", 3],
			["b", 2],
			["c", 1],
		]);

		expect(sidebarProjects(counts, projects, 1, false)).toStrictEqual({
			visible: [
				{name: "a", count: 3, condition: undefined},
				{name: "dirty", count: 0, condition: "local_changes"},
			],
			hiddenCount: 2,
		});
		expect(sidebarProjects(counts, projects, 1, true)).toStrictEqual({
			visible: [
				{name: "a", count: 3, condition: undefined},
				{name: "b", count: 2, condition: undefined},
				{name: "c", count: 1, condition: undefined},
				{name: "dirty", count: 0, condition: "local_changes"},
			],
			hiddenCount: 2,
		});
	});
});
