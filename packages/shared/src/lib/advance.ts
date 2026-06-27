import {type AdvancePlan, type AdvanceUnit} from "./advance-plan.js";
import {AdvanceScheduler, createSystemProbe, type ResourceProbe, type UnitOutcome} from "./advance-scheduler.js";
import {RunMemory, normalizeFailureSignature, type UnitRef} from "./advance-progress.js";
import {type NodeStatus, type ReportNode} from "./advance-report.js";
import {tracedExeca} from "../services/traced-execa.js";
import {getMiseEnv, hasLocalModifications, testBranch, testFix} from "./git.js";

/**
 * In-process advance orchestrator shared by the CLI and web engine. It runs the
 * deterministic plan/scheduler and drives each unit through rebase → resolve
 * conflicts → test → fix → absorb, looping while it makes progress and stopping a
 * unit when the same change reproduces the same failure. The intelligent steps
 * (conflict resolution, fixing) are injected as `AdvanceActions` so the engine is
 * testable without spawning git or Claude.
 */

export type Autonomy = "dry-run" | "run";

export interface AdvanceEvent {
	project: string;
	branch?: string;
	phase: "baseline" | "rebase" | "conflicts" | "test" | "fix" | "absorb" | "done";
	status: "start" | NodeStatus;
	message?: string;
}

export interface AdvanceActions {
	rebase(unit: AdvanceUnit): Promise<{ok: boolean; conflict: boolean; log: string}>;
	test(unit: AdvanceUnit): Promise<{green: boolean; log: string}>;
	resolveConflicts(unit: AdvanceUnit): Promise<{ok: boolean; log: string}>;
	fix(unit: AdvanceUnit): Promise<{changed: boolean; log: string}>;
	absorb(unit: AdvanceUnit): Promise<{ok: boolean; log: string}>;
}

export interface AdvanceProjectOptions {
	autonomy?: Autonomy;
	/** Max units of this repo running at once (the resolved per-repo concurrency). */
	perRepoConcurrency?: number;
	globalConcurrency?: number;
	loadThreshold?: number;
	memFloor?: number;
	maxAttemptsPerUnit?: number;
	probe?: ResourceProbe;
	onEvent?: (event: AdvanceEvent) => void;
}

interface UnitResult {
	status: NodeStatus;
	detail?: string;
}

const TERMINAL_RED: NodeStatus[] = ["red", "stuck"];

function firstSignalLine(log: string): string {
	const line = log
		.split("\n")
		.map((l) => l.trim())
		.find((l) => /FAIL|Error|CONFLICT|AssertionError|✕|not ok|panicked|Exception/.test(l));
	return line ?? "failed";
}

async function advanceUnit(
	unit: AdvanceUnit,
	actions: AdvanceActions,
	memory: RunMemory,
	opts: Required<Pick<AdvanceProjectOptions, "autonomy" | "maxAttemptsPerUnit">>,
	emit: (event: AdvanceEvent) => void,
): Promise<UnitResult> {
	const ref: UnitRef = {project: unit.project, changeIdentity: unit.id};
	const run = opts.autonomy === "run";

	emit({project: unit.project, branch: unit.branch, phase: "rebase", status: "start"});
	const rebased = await actions.rebase(unit);
	if (rebased.conflict) {
		if (!run) return {status: "stuck", detail: "rebase conflicts (dry-run)"};
		const sig = normalizeFailureSignature(rebased.log);
		if (memory.seen(ref, "conflicts", sig)) return {status: "stuck", detail: "repeated conflict"};
		memory.record(ref, "conflicts", sig);
		emit({project: unit.project, branch: unit.branch, phase: "conflicts", status: "start"});
		const resolved = await actions.resolveConflicts(unit);
		if (!resolved.ok) return {status: "stuck", detail: "unresolved conflicts"};
	} else if (!rebased.ok) {
		return {status: "red", detail: "rebase failed"};
	}

	for (let attempt = 0; attempt < opts.maxAttemptsPerUnit + 1; attempt++) {
		emit({project: unit.project, branch: unit.branch, phase: "test", status: "start"});
		const tested = await actions.test(unit);
		if (tested.green) return {status: "green"};

		const sig = normalizeFailureSignature(tested.log);
		if (memory.seen(ref, "test", sig)) {
			return {status: "stuck", detail: firstSignalLine(tested.log)};
		}
		memory.record(ref, "test", sig);

		if (!run) return {status: "red", detail: "test failed (dry-run)"};

		emit({project: unit.project, branch: unit.branch, phase: "fix", status: "start"});
		const fixed = await actions.fix(unit);
		if (!fixed.changed) return {status: "stuck", detail: "fix produced no changes"};

		emit({project: unit.project, branch: unit.branch, phase: "absorb", status: "start"});
		await actions.absorb(unit);
	}

	return {status: "stuck", detail: "max fix attempts"};
}

/**
 * Real actions for a single repo: mechanical git for rebase/test/absorb, and
 * headless Claude (`claude --print <slash-command>`) for the two intelligent
 * steps. The branch is checked out in `dir` (per-repo concurrency defaults to 1,
 * so branches are advanced serially in the repo's own checkout).
 */
export async function createGitActions(config: {dir: string; upstreamRef: string}): Promise<AdvanceActions> {
	const {dir, upstreamRef} = config;
	const env = await getMiseEnv(dir);

	const git = (args: string[]) => tracedExeca("git", ["-C", dir, ...args], {reject: false, env});
	const claude = (command: string) => tracedExeca("claude", ["--print", command], {cwd: dir, reject: false, env});

	return {
		async rebase(unit) {
			const checkout = await git(["checkout", unit.branch]);
			if (checkout.exitCode !== 0) return {ok: false, conflict: false, log: checkout.stderr};
			const rebase = await git(["rebase", "--rebase-merges", "--update-refs", upstreamRef]);
			if (rebase.exitCode === 0) return {ok: true, conflict: false, log: rebase.stdout};
			const out = `${rebase.stdout}\n${rebase.stderr}`;
			const conflict = /CONFLICT|could not apply|Merge conflict/i.test(out);
			return {ok: false, conflict, log: out};
		},
		async test(unit) {
			const result = await testBranch(dir, unit.branch, upstreamRef, env);
			return {green: result.exitCode === 0, log: result.logContent};
		},
		async resolveConflicts() {
			const result = await claude("/git:conflicts");
			const stillRebasing = (await git(["rev-parse", "--git-path", "rebase-merge"])).stdout.trim();
			const inProgress = stillRebasing
				? (await tracedExeca("test", ["-d", stillRebasing], {reject: false})).exitCode === 0
				: false;
			return {ok: result.exitCode === 0 && !inProgress, log: result.stdout};
		},
		async fix() {
			const result = await claude("/build:fix");
			const changed = await hasLocalModifications(dir);
			return {changed, log: result.stdout};
		},
		async absorb(unit) {
			const result = await testFix(dir, unit.branch, upstreamRef, env);
			return {ok: result.ok, log: result.message};
		},
	};
}

export async function advanceProject(
	plan: AdvancePlan,
	actions: AdvanceActions,
	options: AdvanceProjectOptions = {},
): Promise<ReportNode> {
	const opts = {
		autonomy: options.autonomy ?? "run",
		maxAttemptsPerUnit: options.maxAttemptsPerUnit ?? 3,
	};
	const emit = options.onEvent ?? (() => {});
	const memory = new RunMemory();

	const perRepo = options.perRepoConcurrency ?? options.globalConcurrency ?? 1;
	const scheduler = new AdvanceScheduler(plan.units, {
		globalConcurrency: options.globalConcurrency ?? 1,
		loadThreshold: options.loadThreshold ?? 1,
		memFloor: options.memFloor ?? 0.1,
		perRepoConcurrency: () => perRepo,
		probe: options.probe ?? createSystemProbe(),
	});

	const unitsById = new Map(plan.units.map((u) => [u.id, u]));
	const results = new Map<string, UnitResult>();

	while (!scheduler.done) {
		const batch = scheduler.nextAdmissible();
		if (batch.length === 0) break;

		batch.forEach((u) => scheduler.markRunning(u.id));
		await Promise.all(
			batch.map(async (schedUnit) => {
				const unit = unitsById.get(schedUnit.id)!;
				const result = await advanceUnit(unit, actions, memory, opts, emit);
				results.set(unit.id, result);
				const outcome: UnitOutcome = result.status === "green" ? "green" : "red";
				scheduler.recordResult(unit.id, outcome);
			}),
		);
	}

	const children: ReportNode[] = plan.units.map((unit) => {
		const result = results.get(unit.id);
		// A unit with no result was cascade-skipped because a dependency failed.
		const status: NodeStatus = result ? result.status : "skipped";
		const detail = result?.detail ?? "skipped: dependency failed";
		return {label: unit.branch, status, detail, children: []};
	});

	const anyRed = children.some((c) => TERMINAL_RED.includes(c.status));
	const projectStatus: NodeStatus = anyRed ? "red" : "green";
	emit({project: plan.project, phase: "done", status: projectStatus});

	return {label: plan.project, status: projectStatus, children};
}
