# Work-in-Progress Stages

This document describes the lifecycle stages that work items move through in WIP, from initial idea to merged PR.

## Overview

WIP tracks work across multiple git repositories. Each piece of work starts as an idea (issue, project item, todo) and progresses through local development, testing, pushing, PR creation, CI checks, and code review. The system discovers work automatically from git state and GitHub APIs.

## Simple Diagram (NFA)

This diagram shows the intuitive flow. It hides combinatorial state — many of these dimensions are independent and can combine in ways the diagram doesn't show.

```mermaid
flowchart TD
    %% Entry points
    IDEA["💡 Not Started\n(issues, project items, todos)"]
    COMMIT["📝 Detached HEAD\n(bare commit, no branch)"]

    %% Local development
    BRANCH["🌿 Local Branch\n(has branch name)"]
    DIRTY["✏️ Local Changes\n(worktree dirty)"]
    SKIP["⏭️ Skippable\n([skip] in message)"]
    SNOOZE["😴 Snoozed\n(on hold)"]

    %% The rebase+test diamond
    READY_TEST["🧪 Ready to Test"]
    NO_TEST["⚠️ No Test Configured"]
    TESTING["🔄 Testing..."]
    TEST_FAIL["❌ Test Failed"]
    TEST_PASS["✅ Tests Passed"]

    NEEDS_REBASE["🔀 Needs Rebase\n(not descendant of upstream)"]
    REBASED["✅ Rebased\n(descendant of upstream)"]

    %% Diamond convergence
    READY_PUSH["🚀 Ready to Push\n(tested + rebased)"]

    %% Remote stages
    PUSHED["📤 Pushed, Needs PR"]
    PR_CREATED["🔗 PR Created"]

    %% CI checks
    CHECKS_UNKNOWN["❓ Checks Unknown"]
    CHECKS_RUNNING["⏳ Checks Running"]
    CHECKS_FAILED["❌ Checks Failed"]
    CHECKS_PASSED["✅ Checks Passed"]

    %% Review
    REVIEW_COMMENTS["💬 Review Comments"]
    CHANGES_REQ["🔄 Changes Requested"]
    APPROVED["✅ Approved"]

    %% === Edges ===

    IDEA -->|"create branch"| BRANCH
    COMMIT -->|"name branch"| BRANCH

    BRANCH --> SKIP
    BRANCH --> SNOOZE
    BRANCH --> DIRTY
    BRANCH --> NEEDS_REBASE
    BRANCH --> REBASED

    DIRTY -->|"commit/stash"| READY_TEST
    DIRTY -->|"commit/stash"| NEEDS_REBASE

    %% Diamond: rebase and test are independent parallel tracks
    NEEDS_REBASE -->|"git rebase upstream"| REBASED
    REBASED --> READY_TEST
    REBASED --> NO_TEST

    READY_TEST -->|"run test"| TESTING
    NO_TEST -->|"define git-test test"| READY_TEST
    NO_TEST -->|"push anyway"| READY_PUSH
    TESTING -->|pass| TEST_PASS
    TESTING -->|fail| TEST_FAIL
    %% Fix-test cycle (j fix-test)
    TEST_FAIL -->|"edit fix"| DIRTY
    DIRTY -->|"git commit --fixup"| NEEDS_REBASE
    NEEDS_REBASE -->|"git rebase --autosquash"| READY_TEST

    %% Diamond convergence: both rebase and test must pass
    TEST_PASS --> READY_PUSH
    NEEDS_REBASE -.->|"⚠️ blocks push\neven if tested"| READY_PUSH

    READY_PUSH -->|"git push"| PUSHED
    PUSHED -->|"gh pr create"| PR_CREATED

    PR_CREATED --> CHECKS_UNKNOWN
    CHECKS_UNKNOWN --> CHECKS_RUNNING
    CHECKS_RUNNING -->|pass| CHECKS_PASSED
    CHECKS_RUNNING -->|fail| CHECKS_FAILED
    CHECKS_FAILED -->|"fixup, rebase, force-push"| CHECKS_RUNNING

    CHECKS_PASSED --> REVIEW_COMMENTS
    CHECKS_PASSED --> APPROVED
    REVIEW_COMMENTS --> CHANGES_REQ
    REVIEW_COMMENTS --> APPROVED
    CHANGES_REQ -->|"address feedback"| CHECKS_RUNNING
    APPROVED -->|"merge"| MERGED["🎉 Merged"]
```

## State Dimensions (DFA model)

The simple diagram above is an NFA — it hides the fact that many dimensions are independent. The real state of a work item is the combination of all these dimensions. This section enumerates them, like converting an NFA to a DFA.

### Item dimensions

These are properties of an individual work item (commit, branch, or PR).

| Dimension | Values | Notes |
|-----------|--------|-------|
| **Work type** | `idea` / `bare_commit` / `branch` / `pr` | What kind of thing is it |
| **Commits ahead** | 0 / 1 / n | Single-commit branches are most ready |
| **Worktree** | `clean` / `dirty` | Dirty blocks testing |
| **Rebased** | `yes` / `no` | Is upstream/main an ancestor of this branch |
| **Test result** | `untested` / `passed` / `failed` | Result of `git test run` |
| **Remote sync** | `local_only` / `in_sync` / `local_ahead` / `remote_ahead` | Relationship between local and remote branch |
| **CI checks** | `n/a` / `unknown` / `running` / `passed` / `failed` | GitHub Actions status |
| **Review** | `n/a` / `comments` / `changes_requested` / `approved` | PR review status |
| **Override** | `normal` / `snoozed` / `skippable` | User explicitly deprioritized |

### Project dimensions

These are properties of the project, not any individual item. They block or alter the progression of all items in that project.

| Dimension | Values | Notes |
|-----------|--------|-------|
| **Test defined** | `yes` / `no` | Does the project have `git test` configured |
| **Upstream fetched** | `fresh` / `stale` | Has upstream been fetched recently |

### Constraints (unreachable combinations)

Not all dimension combinations are possible. These constraints prune the DFA:

| Constraint | Reason |
|------------|--------|
| `bare_commit` → remote_sync = `local_only` | Can't push without a branch |
| `bare_commit` → rebased = `yes` | Bare commits are children of upstream by definition |
| `idea` → all git dimensions are `n/a` | Ideas have no git state |
| `pr` → remote_sync ≠ `local_only` | PR requires a pushed branch |
| CI checks ≠ `n/a` → work_type = `pr` | Only PRs have CI checks |
| Review ≠ `n/a` → work_type = `pr` | Only PRs have reviews |
| test_result ≠ `untested` → test_defined = `yes` | Can't have test results without a test |
| worktree = `dirty` → test_result = `untested` | Can't test with uncommitted changes |
| remote_sync = `local_only` → CI checks = `n/a` | Nothing pushed, no CI |
| snoozed/skippable → all other dimensions are irrelevant | User override, shown last regardless |

### Full State Table (DFA)

Every reachable state combination, numbered by priority (highest = most done). The queue shows items in descending order.

#### Override states (shown last regardless of other dimensions)

| # | State | Override |
|---|-------|----------|
| 1 | Snoozed | `snoozed` |
| 2 | Skippable | `skippable` |

#### Idea states (no git state)

| # | State | Work type |
|---|-------|-----------|
| 3 | Not started (todo) | `idea` (todo file) |
| 4 | Not started (issue) | `idea` (GitHub issue) |
| 5 | Not started (project item) | `idea` (GitHub project board) |

#### Bare commit states (detached HEAD, no branch)

| # | State | Worktree | Test def | Test result | Notes |
|---|-------|----------|----------|-------------|-------|
| 6 | Bare commit, dirty | dirty | — | untested | Needs commit, then branch |
| 7 | Bare commit, no test | clean | no | untested | Needs branch + test config |
| 8 | Bare commit, untested | clean | yes | untested | Needs branch, then test |
| 9 | Bare commit, test failed | clean | yes | failed | Fix, then create branch |
| 10 | Bare commit, test passed | clean | yes | passed | Just needs a branch name |

#### Branch states (local development)

| # | State | Commits | Worktree | Rebased | Test def | Test result | Remote sync | Notes |
|---|-------|---------|----------|---------|----------|-------------|-------------|-------|
| 11 | Branch, dirty | any | dirty | — | — | untested | — | Needs commit |
| 12 | Branch, no test, not rebased | any | clean | no | no | untested | local_only | Needs rebase + test config |
| 13 | Branch, no test, rebased | any | clean | yes | no | untested | local_only | Stuck: needs test config |
| 14 | Branch, not rebased, untested | any | clean | no | yes | untested | local_only | Needs rebase, then test |
| 15 | Branch, rebased, untested | any | clean | yes | yes | untested | local_only | Ready to test |
| 16 | Branch, not rebased, test failed | any | clean | no | yes | failed | local_only | Fix, rebase, retest |
| 17 | Branch, rebased, test failed | any | clean | yes | yes | failed | local_only | Fix and retest |
| 18 | Branch, not rebased, test passed | any | clean | no | yes | passed | local_only | Rebase (invalidates test?) |
| 19 | Branch, rebased, test passed, multi-commit | n>1 | clean | yes | yes | passed | local_only | Split or squash, then push |
| 20 | Branch, rebased, test passed, single-commit | 1 | clean | yes | yes | passed | local_only | Ready to push |

#### Pushed states (remote branch exists, no PR yet)

| # | State | Remote sync | Notes |
|---|-------|-------------|-------|
| 21 | Pushed, in sync, needs PR | in_sync | Create PR |
| 22 | Pushed, local ahead, needs PR | local_ahead | Push first, then create PR |

#### PR states (CI checks + review)

| # | State | Remote sync | CI checks | Review | Notes |
|---|-------|-------------|-----------|--------|-------|
| 23 | PR, checks unknown | in_sync | unknown | n/a | Waiting for CI |
| 24 | PR, checks running | in_sync | running | n/a | CI in progress |
| 25 | PR, checks failed | in_sync | failed | n/a | Fix, force-push |
| 26 | PR, checks failed, local ahead | local_ahead | failed | n/a | Need to force-push fix |
| 27 | PR, checks passed, no review | in_sync | passed | n/a | Request review |
| 28 | PR, checks passed, review comments | in_sync | passed | comments | Address comments |
| 29 | PR, checks passed, changes requested | in_sync | passed | changes_requested | Address feedback |
| 30 | PR, checks running, approved | in_sync | running | approved | Wait for CI |
| 31 | PR, checks passed, approved | in_sync | passed | approved | Ready to merge |

## Diamonds

### Diamond: Rebase + Test

The most important structural insight is that **rebase** and **test** are independent, parallel requirements that must both be satisfied before pushing:

```mermaid
flowchart LR
    LOCAL["Local Branch"] --> TEST["Test"]
    LOCAL --> REBASE["Rebase onto upstream"]

    TEST -->|passed| READY["Ready to Push"]
    REBASE -->|rebased| READY

    style READY fill:#22c55e,color:#fff
```

A branch can be:
- **Tested but not rebased** — tests passed on the old base, needs `git rebase upstream/main`
- **Rebased but not tested** — freshly rebased, needs test run
- **Neither** — just created, needs both
- **Both** — ready to push

This means after a rebase, tests should re-run (since the code has changed). And after fixing a test failure, you don't need to re-rebase (the base hasn't changed). The classify logic should track these independently.

### Diamond: CI Checks + Review

A second diamond exists after PR creation:

```mermaid
flowchart LR
    PR["PR Created"] --> CHECKS["CI Checks"]
    PR --> REVIEW["Code Review"]

    CHECKS -->|passed| READY["Ready to Merge"]
    REVIEW -->|approved| READY

    style READY fill:#22c55e,color:#fff
```

Currently the UI treats these as a linear sequence (checks → review → approved), but in practice:
- A reviewer can approve while checks are still running
- Checks can pass before review is requested
- Both must be green to merge

## Card Ordering Within Categories

Within each kanban column or queue category, cards are ordered by readiness — how close they are to being pushed to GitHub:

1. **Pull requests** — already on GitHub, furthest along
2. **Single-commit branches** (`commitsAhead = 1`) — just need `git push`
3. **Bare commits** — need a branch name created, then push
4. **Multi-commit branches** (`commitsAhead > 1`) — need splitting or squashing before landing
5. **Issues, project items, todos** — not yet started

This reflects a one-commit-at-a-time workflow where each branch should ideally contain a single atomic commit.

## Classify Logic → DFA Mapping

The current `classify.ts` maps items to the old `Category` enum. This section traces every code path and maps it to a DFA state, revealing which states are distinguished vs collapsed.

### classifyCommit (bare commits — CommitItem)

| Code path | Old category | DFA # | DFA state | Notes |
|-----------|-------------|-------|-----------|-------|
| `commit.skippable` | `skippable` | 2 | Skippable | |
| `project.detachedHead` | `detached_head` | 6–10 | Bare commit (any) | Collapses all bare commit substates |
| `project.dirty` | `local_changes` | 6 | Bare commit, dirty | |
| `!project.hasTestConfigured` | `no_test` | 7 | Bare commit, no test | |
| default | `ready_to_test` | 8 | Bare commit, untested | |

**Missing**: CommitItem has no `testStatus` field, so #9 (bare commit, test failed) and #10 (bare commit, test passed) are unreachable. Bare commits can't be tested in the current model.

### classifyBranch (branches — BranchItem)

| Code path | Old category | DFA # | DFA state | Notes |
|-----------|-------------|-------|-----------|-------|
| `branch.skippable` | `skippable` | 2 | Skippable | |
| `testStatus === 'failed'` | `test_failed` | 16 or 17 | Branch, test failed | Not checking rebased |
| `pushedToRemote && branch !== upstream` | `pushed_no_pr` | 21 or 22 | Pushed, needs PR | Not checking sync state |
| `testStatus === 'passed'` | `ready_to_push` | 18–20 | Branch, test passed | Not checking rebased or commit count |
| `project.dirty` | `local_changes` | 11 | Branch, dirty | |
| `!project.hasTestConfigured` | `no_test` | 12 or 13 | Branch, no test | Not checking rebased |
| default | `ready_to_test` | 14 or 15 | Branch, untested | Not checking rebased |

**Missing**: `needsRebase` field exists on BranchItem but classify ignores it. `commitsAhead` exists but classify ignores it. States #12, #14, #16, #18, #19 are collapsed with their rebased counterparts.

### classifyPullRequest (PRs — PullRequestItem)

| Code path | Old category | DFA # | DFA state | Notes |
|-----------|-------------|-------|-----------|-------|
| `pr.skippable` | `skippable` | 2 | Skippable | |
| `reviewStatus === 'approved'` | `approved` | 31 | PR, approved | Doesn't check if checks also passed |
| `reviewStatus === 'changes_requested'` | `changes_requested` | 29 | PR, changes requested | |
| `reviewStatus === 'commented'` | `review_comments` | 28 | PR, review comments | |
| `checkStatus === 'running'/'pending'` | `checks_running` | 24 | PR, checks running | |
| `checkStatus === 'failed'` | `checks_failed` | 25 | PR, checks failed | |
| `checkStatus === 'passed'` | `checks_passed` | 27 | PR, checks passed | |
| `checkStatus === 'unknown'/'none'` | `checks_unknown` | 23 | PR, checks unknown | |
| default | `checks_running` | 24 | PR, checks running | Fallback |

**Missing**: #26 (checks failed + local ahead), #30 (checks running + approved — the diamond case). Review is checked before checks, so `approved` with failing checks shows as `approved` not `checks_failed`.

### Idea items (not classified — added directly in useWorkItems)

| Source | DFA # | DFA state |
|--------|-------|-----------|
| TodoItem | 3 | Not started (todo) |
| IssueItem | 4 | Not started (issue) |
| ProjectBoardItem | 5 | Not started (project item) |
| SnoozedChild | 1 | Snoozed |

### Summary: DFA states reachable in current code

| DFA # | State | Reachable? | Via |
|-------|-------|------------|-----|
| 1 | Snoozed | yes | snoozed query |
| 2 | Skippable | yes | all three classifiers |
| 3 | Not started (todo) | yes | useWorkItems |
| 4 | Not started (issue) | yes | useWorkItems |
| 5 | Not started (project item) | yes | useWorkItems |
| 6 | Bare commit, dirty | yes | classifyCommit |
| 7 | Bare commit, no test | yes | classifyCommit |
| 8 | Bare commit, untested | yes | classifyCommit |
| 9 | Bare commit, test failed | **bug** | CommitItem drops testStatus from ChildCommit |
| 10 | Bare commit, test passed | **bug** | CommitItem drops testStatus from ChildCommit |
| 11 | Branch, dirty | yes | classifyBranch |
| 12 | Branch, no test, not rebased | **collapsed** | shown as #13 (no_test) |
| 13 | Branch, no test, rebased | yes | classifyBranch |
| 14 | Branch, not rebased, untested | **collapsed** | shown as #15 (ready_to_test) |
| 15 | Branch, rebased, untested | yes | classifyBranch |
| 16 | Branch, not rebased, test failed | **collapsed** | shown as #17 (test_failed) |
| 17 | Branch, rebased, test failed | yes | classifyBranch |
| 18 | Branch, not rebased, test passed | **collapsed** | shown as #20 (ready_to_push) |
| 19 | Branch, rebased, test passed, multi | **collapsed** | shown as #20 (ready_to_push) |
| 20 | Branch, rebased, test passed, single | yes | classifyBranch |
| 21 | Pushed, in sync, needs PR | yes | classifyBranch |
| 22 | Pushed, local ahead, needs PR | **collapsed** | shown as #21 |
| 23 | PR, checks unknown | yes | classifyPullRequest |
| 24 | PR, checks running | yes | classifyPullRequest |
| 25 | PR, checks failed | yes | classifyPullRequest |
| 26 | PR, checks failed, local ahead | **collapsed** | shown as #25 |
| 27 | PR, checks passed, no review | yes | classifyPullRequest |
| 28 | PR, review comments | yes | classifyPullRequest |
| 29 | PR, changes requested | yes | classifyPullRequest |
| 30 | PR, checks running, approved | **collapsed** | shown as #31 (approved) |
| 31 | PR, approved | yes | classifyPullRequest |

**20 of 31 states are reachable.** 11 are collapsed or unreachable:
- 2 unreachable (bare commit test results — no field exists)
- 9 collapsed (rebase status, commit count, and remote sync not checked)

## Current Limitations

### Missing: Needs Rebase Stage

**Currently, branches that are not descendants of `upstream/main` are invisible.** The `git children` command only returns commits that descend from the upstream ref. Branches that diverged before the latest upstream (i.e., need rebasing) simply don't appear in the UI.

This should be fixed so that:
1. All local branches are discovered (not just children of upstream)
2. Branches not containing upstream are classified as `needs_rebase`
3. The rebase+test diamond is properly modeled in the classify logic

### Missing: Independent Rebase + Test Tracking

The current classify logic treats rebase and test as sequential. A branch that's been tested but needs rebase is invisible (not a child of upstream). A branch that's been rebased but not tested shows as `ready_to_test`. The diamond relationship isn't tracked.

Ideally, the UI would show:
- "Needs rebase" — not a descendant of upstream
- "Needs rebase + test" — neither done
- "Needs test" — rebased but untested
- "Ready to push" — both done

### Missing: Remote Sync Tracking

The current model treats "pushed" as a binary state. It doesn't track whether the local branch is ahead of, behind, or in sync with the remote branch. This matters for:
- Knowing when a force-push is needed after fixup+rebase
- Detecting when remote has diverged (e.g., after pushing from another machine)
- Distinguishing "needs push" from "needs PR creation"

### Missing: Project-Level Properties

`no_test` and `upstream_stale` are properties of the **project**, not individual items. They should be surfaced as project-level warnings when that project has active work items, rather than mixed into the item state machine.
