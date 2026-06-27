---
name: advance-branch
description: Advance a single branch as a leaf of the /wip-advance tree — test it and, on failure, run the build:test-branch fix loop, stopping when stuck on the same failure. Invoked by the advance-project agent — one per branch unit.
---

# Advance one branch

You are an L3 leaf in the advance tree. Your input is one branch unit:
`{ project, dir, branch, tipSha, upstreamRef, worktreeRequired }`. Your job is to get this branch's
commits green (or determine it is stuck), then return a single branch report node.

## Work in an isolated checkout when required

If `worktreeRequired` is true, the branch is not the repo's current checkout, so it cannot be checked
out in `dir` without disturbing other workers. Create a dedicated worktree with
`git -C <dir> worktree add <path> <branch>` and do all of this branch's work there, removing it with
`git -C <dir> worktree remove --force <path>` when done. If `worktreeRequired` is false, work in
`dir`. Run the test/fix commands below from inside whichever working directory you settled on (the
`just`/git-test recipes act on the current directory), and load the repo's environment first
(direnv/mise) so the tests see the right toolchain.

## Run the test-and-fix loop

Drive the branch with the `/build:test-branch` loop: it tests every commit in
`<upstreamRef>..<branch>`, and on a failure runs `/build:fix` and `j test-fix` (stage → pre-commit →
`commit --fixup HEAD` → autosquash rebase) to absorb the fix, then retests — repeating while it makes
progress. A fix often leaves working-tree changes; `j test-fix` is what folds them back into the
failing commit.

## Stop when stuck on the same change

Keep looping as long as each attempt changes the outcome. Stop a commit when the **same change
reproduces the same failure** — the fix did not move the needle. `j test-fix` itself can fail with a
merge conflict, a build error, or a test failure; treat a repeat of the identical failure signature
on the identical change as stuck rather than retrying forever. Honor the standard iteration cap (the
`/build:test-branch` loop already bounds itself).

## Return the branch node

Return `{ label: branch, status, detail }`:

- `green` — every commit passed (possibly after fixes).
- `stuck` — a commit could not be made green; `detail` names the failing test/step.
- `red` — testing failed and no fix was attempted or possible; `detail` summarizes why.

Clean up any worktree you created before returning.
