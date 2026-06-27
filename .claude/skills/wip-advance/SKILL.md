---
name: wip-advance
description: Advance work-in-progress across many repos by fanning out a subagent tree that rebases every branch, resolves conflicts, tests, and fixes failures — looping while it makes progress and ending with a ✅/❌ tree report. Use when the user wants to advance, process, or sweep their WIP across projects (the manual `j g` → /git:conflicts → `j ta` → /build:fix loop, automated). Accepts optional include/exclude project filters.
---

# Advance work-in-progress

Automates the manual loop the user runs per repo today — `j g` (rebase every branch onto
`UPSTREAM_REMOTE/UPSTREAM_BRANCH`) → `/git:conflicts` on conflict → `j ta` (test every branch) →
`/build:fix` on failure → `j test-fix` to absorb the fix — and fans it out across every selected
project and branch as a tree of subagents.

The deterministic decisions (which projects, the DAG-deduped unit list per project, per-repo
concurrency, whether the baseline needs testing) come from the `wip advance` CLI. This skill is the
root (L1) of the tree: it turns that plan into project subagents, gates how fast they spawn by live
machine load, and renders the final report.

## Tool choice: mechanical vs. Claude

Use the **mechanical** command for anything deterministic; only spend a subagent where judgment over
file contents is required.

- Rebase, test, absorb-fix (`j test-fix`), prune — mechanical (`git`, `just --global-justfile …`,
  `wip`).
- Resolve merge conflicts — `/git:conflicts` (fully qualified, never the `conflicts` shorthand).
- Fix a failing build/test — `/build:fix`, or the `/build:test-branch` loop which already wraps
  test → `/build:fix` → `j test-fix` → retest.

## Compute the plan

Run `wip advance plan --json`, passing the user's filters as repeated `--include` / `--exclude`
globs (or a single project name as the positional argument). The output is one entry per advanceable
project: `{ project, dir, upstreamRef, upstreamRemote, upstreamBranch, concurrency, baseline:
{ sha, needsTest }, units: [{ id, branch, tipSha, chain, dependsOn, worktreeRequired }] }`.

If the list is empty, report that there is nothing to advance and stop.

## Fan out one subagent per project

Spawn an `advance-project` subagent per project, passing that project's full plan entry as JSON in
the prompt. Spawn in waves rather than all at once: before each wave run `wip advance admit --json`
and only start more projects while it reports `ok: true`; otherwise wait for a running project to
finish first. Always keep at least one project advancing so a loaded machine still progresses.

Each `advance-project` subagent returns a project report node (the project plus a ✅/❌/🛑/⏭️/⚠️
result for every branch it touched).

## Render the report

Assemble the project nodes under a single root node and render the tree with red/green emoji and
branch names, mirroring the subagent tree. Lead with anything that needs the user's attention —
projects where the baseline was broken and fixed (⚠️), and branches left stuck (🛑) with the failure
detail — then the fully-green projects.
