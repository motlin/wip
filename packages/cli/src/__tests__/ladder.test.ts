import {afterEach, describe, expect, it, vi} from "vite-plus/test";

import type {LadderResult, ProjectInfo} from "@wip/shared";

type Shared = typeof import("@wip/shared");

vi.mock("@wip/shared", () => ({
	getProjectsDirs: vi.fn<Shared["getProjectsDirs"]>((flag?: string) => [flag ?? "/tmp/fake-projects"]),
	discoverAllProjects: vi.fn<Shared["discoverAllProjects"]>(),
	createSystemProbe: vi.fn<Shared["createSystemProbe"]>(() => ({loadPerCore: () => 0, freeMemRatio: () => 1})),
	createRepoResourceLock: vi.fn<Shared["createRepoResourceLock"]>(() => async () => Promise.resolve(() => {})),
	matchesFilters: vi.fn<Shared["matchesFilters"]>(() => true),
	runLadderAcrossProjects: vi.fn<Shared["runLadderAcrossProjects"]>(),
	ladderResultsToTree: vi.fn<Shared["ladderResultsToTree"]>(),
	renderTree: vi.fn<Shared["renderTree"]>(() => "TREE"),
	inventoryExists: vi.fn<Shared["inventoryExists"]>(() => true),
	getInventoryPath: vi.fn<Shared["getInventoryPath"]>(() => "/tmp/fake-config/wip/projects.json5"),
}));

import {
	discoverAllProjects,
	inventoryExists,
	ladderResultsToTree,
	matchesFilters,
	runLadderAcrossProjects,
} from "@wip/shared";

function proj(name: string): ProjectInfo {
	return {
		name,
		dir: `/tmp/fake-projects/${name}`,
		remote: `u/${name}`,
		originRemote: "origin",
		upstreamRemote: "upstream",
		upstreamBranch: "main",
		upstreamRef: "upstream/main",
		dirty: false,
		detachedHead: false,
		branchCount: 1,
		hasTestConfigured: true,
		rebaseInProgress: false,
	};
}

const okResult = (name: string): LadderResult => ({
	project: name,
	rungs: [{rung: "fetch", status: "passed", detail: "ok"}],
});

const tree = {label: "ladder", status: "green" as const, children: []};

function capture() {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return {lines, restore: () => (console.log = original)};
}

describe("wip ladder", () => {
	const restores: Array<() => void> = [];
	afterEach(() => {
		for (const r of restores.splice(0)) r();
		vi.clearAllMocks();
	});

	it("describes what the ladder does in plain words", async () => {
		const {default: Ladder} = await import("../commands/ladder.js");
		expect(Ladder.description).toBe(
			"Bring repos' branches up to date safely: fetch upstream, fast-forward and rebase local branches, delete merged branches, and prune stale worktrees. Stops at conflicts it can't resolve; never pushes.",
		);
	});

	it("runs the ladder for all projects with --all and returns JSON", async () => {
		vi.mocked(discoverAllProjects).mockResolvedValue([proj("a"), proj("b")]);
		vi.mocked(runLadderAcrossProjects).mockResolvedValue([okResult("a"), okResult("b")]);
		vi.mocked(ladderResultsToTree).mockReturnValue(tree);
		const c = capture();
		restores.push(c.restore);

		const {default: Ladder} = await import("../commands/ladder.js");
		const result = await Ladder.run(["--all", "--json", "--projects-dir", "/tmp/fake-projects"]);
		c.restore();

		expect(result).toEqual({
			dryRun: false,
			results: [okResult("a"), okResult("b")],
			tree,
		});
		expect(vi.mocked(runLadderAcrossProjects).mock.calls[0]?.[0].map((p) => p.name)).toEqual(["a", "b"]);
		expect(vi.mocked(runLadderAcrossProjects).mock.calls[0]?.[1].dryRun).toBe(false);
		// --json means stdout holds only the JSON document
		expect(JSON.parse(c.lines.join("\n"))).toEqual(result);
	});

	it("limits to a named project and passes --dry-run", async () => {
		vi.mocked(discoverAllProjects).mockResolvedValue([proj("a"), proj("b")]);
		vi.mocked(runLadderAcrossProjects).mockResolvedValue([okResult("b")]);
		vi.mocked(ladderResultsToTree).mockReturnValue(tree);
		const c = capture();
		restores.push(c.restore);

		const {default: Ladder} = await import("../commands/ladder.js");
		const result = await Ladder.run(["b", "--dry-run"]);
		c.restore();

		const call = vi.mocked(runLadderAcrossProjects).mock.calls[0];
		expect(call?.[0].map((p) => p.name)).toEqual(["b"]);
		expect(call?.[1].dryRun).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(c.lines.join("\n")).toContain("TREE");
	});

	it("errors when neither a project nor --all is given", async () => {
		vi.mocked(discoverAllProjects).mockResolvedValue([proj("a")]);
		const {default: Ladder} = await import("../commands/ladder.js");
		await expect(Ladder.run([])).rejects.toThrow(/project|--all/);
		expect(runLadderAcrossProjects).not.toHaveBeenCalled();
		expect(matchesFilters).not.toHaveBeenCalled();
	});

	it("refuses --all when no project registry exists, without scanning directories", async () => {
		vi.mocked(inventoryExists).mockReturnValueOnce(false);
		const {default: Ladder} = await import("../commands/ladder.js");
		await expect(Ladder.run(["--all"])).rejects.toThrow(
			"No project registry at /tmp/fake-config/wip/projects.json5; import one with `wip inventory import` before running the ladder on every project",
		);
		expect(discoverAllProjects).not.toHaveBeenCalled();
		expect(runLadderAcrossProjects).not.toHaveBeenCalled();
	});

	it("still runs a single named project when no registry exists", async () => {
		vi.mocked(inventoryExists).mockReturnValue(false);
		vi.mocked(discoverAllProjects).mockResolvedValue([proj("a"), proj("b")]);
		vi.mocked(runLadderAcrossProjects).mockResolvedValue([okResult("a")]);
		vi.mocked(ladderResultsToTree).mockReturnValue(tree);
		const c = capture();
		restores.push(c.restore);

		const {default: Ladder} = await import("../commands/ladder.js");
		await Ladder.run(["a", "--json"]);
		c.restore();
		vi.mocked(inventoryExists).mockReturnValue(true);

		expect(vi.mocked(runLadderAcrossProjects).mock.calls[0]?.[0].map((p) => p.name)).toEqual(["a"]);
	});
});
