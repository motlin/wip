# Advance Plan UI

## Goal

Replace the one-click `Advance All` queue action with a staged workflow:

- Generate a read-only plan first.
- Show the projects and branches that would be touched before mutation.
- Offer small per-branch action buttons that enqueue visible Tasks.
- Add bulk actions only after explicit selection and review.

## Current Behavior

`packages/web/src/routes/_dashboard/queue.tsx` calls `advanceAll({data: {}})` directly from `handleAdvanceAll`.

`packages/web/src/lib/server-fns.ts` implements `advanceAllHandler`, which discovers all projects, skips dirty/detached/no-test projects, computes a plan with `planProject`, creates real git actions with `createGitActions`, then calls `advanceProject`.

`packages/shared/src/lib/advance.ts` performs mutating work: rebases branches, invokes `/git:conflicts`, runs tests, invokes `/build:fix`, creates fixup commits, autosquashes, and retests.

`packages/web/src/lib/task-queue.ts` already gives visible progress for `test`, `rebase`, `claude`, and `push` tasks. Existing server functions expose `testChild`, `rebaseChild`, and `runClaudeCommand`.

## Target UX

Queue page:

- Replace `Advance All` with `Generate Advance Plan`.
- Navigate to `/advance-plan`.
- Keep existing `Rebase All` and `Run All Tests` behavior for now.

Advance plan page:

- Generate a read-only plan on load and via `Refresh Plan`.
- Group projects by `ready`, `skipped`, and `noop`.
- Show skip reasons for dirty worktrees, detached heads, and missing test config.
- For ready projects, show upstream ref, concurrency, baseline status, and branch units.
- For each branch, show branch name, tip SHA, owned commit count, dependencies, and expected actions.
- Link to `/tasks` for logs and progress.

Per-branch nudge buttons:

- `Run Tests`: call `testChild`.
- `Rebase Branch`: call `rebaseChild`.
- `Resolve Conflicts`: call `runClaudeCommand` with `/git:conflicts`.
- `Fix Failure`: call `runClaudeCommand` with `/build:fix`.

Bulk action:

- Add `Advance Selected` only after the per-branch workflow exists.
- Require checkboxes and a confirmation summary.
- Prefer enqueueing visible tasks over calling `advanceAll`.

## Implementation Slices

### Read-Only Plan Server Function

Add `generateAdvancePlan` near `advanceAll` in `packages/web/src/lib/server-fns.ts`.

Requirements:

- Accept optional `include` and `exclude` arrays.
- Use `discoverAllProjects(getProjectsDirs())`.
- Use `matchesFilters`.
- Use `planProject` and `resolveAdvanceConcurrency`.
- Return skipped projects with reasons.
- Return noop projects when there are no units and the baseline does not need testing.
- Never call `createGitActions`, `advanceProject`, git rebase, git test, or Claude.

Suggested DTO:

```ts
export interface AdvancePlanBranchSummary {
	project: string;
	branch: string;
	tipSha: string;
	shortSha: string;
	ownedCommitCount: number;
	dependsOn: string[];
	worktreeRequired: boolean;
	expectedActions: Array<"rebase" | "test" | "resolve-conflicts" | "fix-failure">;
}

export interface AdvancePlanProjectSummary {
	project: string;
	projectDir: string;
	upstreamRef: string;
	upstreamRemote: string;
	upstreamBranch: string;
	remote: string;
	status: "ready" | "skipped" | "noop";
	detail?: string;
	baselineNeedsTest: boolean;
	concurrency: number;
	branches: AdvancePlanBranchSummary[];
}

export interface AdvancePlanSummary {
	generatedAt: number;
	projects: AdvancePlanProjectSummary[];
}
```

### Plan Page

Add `packages/web/src/routes/advance-plan.tsx`.

Requirements:

- Follow the compact operational style used by `tasks.tsx` and the queue routes.
- Render ready, skipped, and noop project sections.
- Provide `Refresh Plan`.
- Show per-branch action buttons.
- Disable actions for skipped and noop projects.
- Show returned task id/status after each action.
- Link to `/tasks`.

### Queue Entry Point

Edit `packages/web/src/routes/_dashboard/queue.tsx`.

Requirements:

- Remove the direct `handleAdvanceAll` path from the Queue page.
- Replace the button with `Generate Advance Plan` linking to `/advance-plan`.
- Keep existing `Rebase All` and `Run All Tests` controls unchanged.

### Tests

Add focused coverage in `packages/web/src/lib/server-fns.test.ts` or the nearest existing server function test file.

Test cases:

- Skips dirty, detached, and no-test projects.
- Returns noop when there are no branch units and the baseline is already green.
- Returns ready branch summaries for planned units.
- Fails if the read-only planning path calls `createGitActions` or `advanceProject`.

## Task List

The detailed implementation tasks were also appended to `.llm/todo.md` in the worktree. That file is ignored by git, but it is available locally at `/Users/craig/projects/wip-advance-plan-ui/.llm/todo.md`.
