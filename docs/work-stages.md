# Work-in-Progress Stages

This document describes the lifecycle stages that work items move through in WIP, from initial idea to merged PR.

## Overview

WIP tracks work across multiple git repositories. Each piece of work starts as an idea (issue, project item, todo) and progresses through local development, testing, pushing, PR creation, CI checks, and code review. The system discovers work automatically from git state and GitHub APIs.

## Stage Diagram

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

## Diamond: Rebase + Test

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

## Diamond: CI Checks + Review

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

## State Ordering

Every work item is in exactly one state. States are strictly ordered from least done (1) to most done (17). The queue view shows items in reverse order (most done first). Cycles exist in the diagram (e.g., checks failed → fix → push again), but the item's state always reflects its current position in this list.

| # | State | Category | Description |
|---|-------|----------|-------------|
| 1 | Snoozed | `snoozed` | User manually snoozed the item |
| 2 | Skippable | `skippable` | Commit message contains `[skip]`, `[pass]`, `[stop]`, or `[fail]` |
| 3 | Not Started | `not_started` | Issues, project items, or todos not yet worked on |
| 4 | No Test | `no_test` | Project has no `git test` configured |
| 5 | Detached HEAD | `detached_head` | Bare commit with no branch name |
| 6 | Local Changes | `local_changes` | Worktree is dirty (uncommitted changes) |
| 7 | Ready to Test | `ready_to_test` | Branch exists, worktree clean, tests not yet run |
| 8 | Test Failed | `test_failed` | `git test run` exited non-zero |
| 9 | Ready to Push | `ready_to_push` | Tests passed, ready for `git push` |
| 10 | Pushed, Needs PR | `pushed_no_pr` | Branch pushed to remote, no open PR |
| 11 | Checks Unknown | `checks_unknown` | PR exists, no CI status yet |
| 12 | Checks Running | `checks_running` | CI checks in progress |
| 13 | Checks Failed | `checks_failed` | CI checks failed (fix locally, force-push) |
| 14 | Checks Passed | `checks_passed` | CI checks passed, awaiting review |
| 15 | Review Comments | `review_comments` | Reviewer left comments |
| 16 | Changes Requested | `changes_requested` | Reviewer requested changes |
| 17 | Approved | `approved` | PR approved and ready to merge |

When fixing failures (test failed, checks failed, changes requested), the work happens locally (edit, fixup, rebase, push) but the item's state stays at its current position — it doesn't regress to `local_changes`. A PR with failed checks that you're fixing locally is still at state 13, not state 6, because the PR infrastructure already exists.

## Card Ordering Within Categories

Within each kanban column or queue category, cards are ordered by readiness — how close they are to being pushed to GitHub:

1. **Pull requests** — already on GitHub, furthest along
2. **Single-commit branches** (`commitsAhead = 1`) — just need `git push`
3. **Bare commits** — need a branch name created, then push
4. **Multi-commit branches** (`commitsAhead > 1`) — need splitting or squashing before landing
5. **Issues, project items, todos** — not yet started

This reflects a one-commit-at-a-time workflow where each branch should ideally contain a single atomic commit.

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
