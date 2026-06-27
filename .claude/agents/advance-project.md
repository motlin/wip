---
name: advance-project
description: Advance one project's branches as part of the /wip-advance tree. Given a single project's advance plan (JSON), check the baseline, fix a broken upstream, then fan out an advance-branch subagent per unit respecting dependencies and per-repo concurrency. Invoked by the wip-advance skill — one per project.
---

# Advance one project

You are an L2 node in the advance tree. Your input is one project's plan entry as JSON:
`{ project, dir, upstreamRef, upstreamRemote, upstreamBranch, concurrency, baseline: { sha,
needsTest }, units: [{ id, branch, tipSha, chain, dependsOn, worktreeRequired }] }`.

Run every git command against the project's `dir` (e.g. `git -C <dir> …`), and set
`UPSTREAM_REMOTE`/`UPSTREAM_BRANCH` from the plan so the justfile recipes target the right ref.
Return a single project report node: the project label plus a child node per branch you touched with
status `green` | `red` | `stuck` | `skipped` and a short detail. Never abort the whole project on one
branch's failure — record it and move on.

## Check the baseline first

If `baseline.needsTest` is true, test the baseline commit (`git -C <dir> test run --retest
<baseline.sha>`).

If the baseline is **red**, the failure is in the shared base, not the branches. Fix it before
touching any branch: create a local base branch at `baseline.sha`, run `/build:fix` there to make it
green, then rebase every unit's branch onto the fixed base mechanically. Mark the project node
`upstream_fixed` with a detail naming the fixed base, and continue with the branch units on top of
the fix.

If the baseline is green (or already cached green), proceed straight to the units.

## Rebase each branch, resolving conflicts

For each unit, mechanically rebase its branch onto the upstream ref
(`git rebase --rebase-merges --update-refs <upstreamRef>`). If the rebase reports conflicts, invoke
`/git:conflicts` to resolve them and continue; if `/git:conflicts` cannot make progress, abort that
branch's rebase, mark the branch `stuck` with the conflict detail, and skip its unit.

## Fan out branch workers respecting dependencies and concurrency

A unit may start only once every unit in its `dependsOn` has come back `green` — those are shared
ancestors that must pass first; if a dependency ends non-green, mark the dependent `skipped`
(its base is broken). Run at most `concurrency` branch workers at a time for this project (the
per-repo budget; default 1 serial).

For each runnable unit, spawn an `advance-branch` subagent, passing `{ project, dir, branch, tipSha,
upstreamRef, worktreeRequired }`. Collect its returned branch node into your project report.

## Assemble the project node

Return `{ label: project, status, children: [branch nodes…] }`. Set the project status from its
children: `upstream_fixed` if you fixed the baseline, otherwise `red` if any branch is red/stuck,
else `green`.
