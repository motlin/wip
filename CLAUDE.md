# CLAUDE.md

## Project Overview

`wip` is a monorepo managed with pnpm workspaces and built with the Vite+ toolchain. It has three packages:

- `packages/shared` (`@wip/shared`) -- shared library with database layer, GitHub API client, and git operations
- `packages/web` (`@wip/web`) -- TanStack Start web dashboard
- `packages/cli` (`@wip/cli`) -- CLI tool

## Design Principles

- wip is Toyota/lean WIP reduction: finish small, independent work instead of advancing everything. The unit is the commit.
- Ready to land = up to date with upstream + green, the "Ready to Push (tested + rebased)" state of the `docs/work-stages.md` state machine, where the rebase and test tracks converge. A commit behind upstream is Needs Rebase, on the item page, the kanban and /queue alike. Ready to land is not a separate section: Ready to Land (`ready_to_push`), Checks Running, Checks Failed, Checks Passed and Approved are the last columns, placed by the ready buffer's verdict and ordered by its stable row order (`docs/work-stages.md`).
- Keep 2-3 commits fully ready (the ready target) and advance lazily, by priority: after a restart or an upstream move, the ready count is recomputed from up-to-date green commits only, and the buffer rebases and retests the highest-priority candidates until the target is met again.
- Never list or count a behind commit as ready.
- Blockers rank above what they block: /queue opens with Set Up PR Refs, then Upstream Red, then Remote Only, all above the landing columns (`docs/work-stages.md`).

## Build and Check Commands

- `just build` -- build all packages
- `just check` -- format + lint + typecheck (with `--fix`)
- `just test` -- build then run all tests
- `just verify` -- check + build + typecheck + test (`just precommit` is a deprecated alias)
- `pnpm --filter @wip/shared build` -- build the shared package only
- `pnpm -r run test` -- run tests across all packages

## Servers and Databases

- `just serve` -- production build on port 3456 (wip.m4.notlin.com), database `~/.local/share/wip/wip.db`
- `just dev` -- dev server on port 3457 (wip-dev.m4.notlin.com), database `~/.local/share/wip/wip-dev.db`
- `WIP_DB_PATH` overrides the database file (`resolveDbPath` in `packages/shared/src/lib/db.ts`); `just dev` sets it so dev and production never share a database. Both scan state from disk independently.
- `WIP_READY_BUFFER=false` (also `0`, `off`) keeps the ready buffer (`readyBufferEnabled` in `packages/web/src/lib/ready-buffer.ts`) from starting; it is on by default in production and `just dev` turns it off. A process lock (`~/.cache/wip/locks/ready-buffer.lock`) stops a second process from running it on the same repos even when both have it enabled.
- Draft-PR verification is opt-in per repo: `verify: "draft-pr"` on its entry in `~/.config/wip/projects.json5` (`draftPrVerification` in `packages/shared/src/lib/inventory.ts`). With `landing: "pull-request"` also set explicitly, a public PR target (`prRepository`) and a workflow on the upstream branch that runs on `pull_request`, the ready buffer runs no local `git test` for that repo (baseline included): it force-pushes each commit with lease to its origin branch, opens one draft PR per branch (reused across rebases), and its GitHub checks decide green or checks failed. Any open PR whose head (`headRefOid`) is the commit's exact sha counts the same way, so an amend pushed by hand or a restart (which drops the in-memory marker) keeps a green PR card in the landing columns. Draft PRs awaiting checks count toward the ready target, a push the GitHub Actions gate holds retries after 60s, and Open PR on such a card marks the draft ready (`gh pr ready`) and turns on auto-merge where allowed. A private repo, one without `pull_request` workflows, one without explicit pull-request landing, or one where the GitHub token can't open the PRs (head branch in the PR repo itself and the token's `viewerPermission` there below WRITE; a fork's head needs only read; `prTokenShortfall` in `packages/shared/src/lib/github-viewer-permission.ts`) keeps local tests, and the Ready to Land column header says why. Open PR on such a token-short repo still pushes with git, then sends the tab to GitHub's prefilled new-PR (compare) page instead of opening the PR through the API.
- Background repo work (ready buffer, Push main pre-testing, background push) runs once per git repository: a registered project whose git top level is another listed project's dir (e.g. `kind: "nested"`), or that shares a top level with one, gets none (`sharedRepoOwners` in `packages/shared/src/lib/git-repo-owner.ts`; the owner is the project whose dir is the top level, else the first by name), and the Ready to Land column header notes it once.
- Background AI agents (the ready buffer's test fix and conflict resolution, the ladder's test/fix and conflict rungs) run in throwaway worktrees under `~/.cache/wip/test-fix-worktrees` and `~/.cache/wip/conflict-worktrees`, and launch only where Claude already trusts the repo (`untrustedWorktreeFolder` in `packages/web/src/lib/herdr/claude-trust.ts`, read-only on Claude's `~/.claude.json` or `$CLAUDE_CONFIG_DIR/.claude.json`). Claude trusts a linked worktree through its repo's main checkout, never through a folder above the worktree, so otherwise the Ready to Land column header says once: trust <repo> in Claude (open `claude` there once and accept). wip never edits Claude's config.
- Background `git test run`s (ready buffer, Push main pre-testing) run under `nice -n 10` with `VITEST_MAX_WORKERS` / `WIP_BACKGROUND_JOBS` set from config key `background.testWorkers` (default 2); user-initiated actions keep normal priority. On battery (`pmset -g batt`, read every 30s) the buffer starts nothing, `pauseOnBattery` jobs wait in the work queue, and the Ready to Land column header says "Paused on battery".

## Testing

### Patterns

- **Git environment**: `git-env-setup.ts` (every package's vitest setup) runs `sanitizeGitEnv`: inherited `GIT_*` variables are dropped, global/system git config is hidden, and `core.fsmonitor=false` is pinned via `GIT_CONFIG_COUNT`, so no temp repo starts a git fsmonitor daemon (leaked daemons exhaust macOS FSEvents). It also points `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `CLAUDE_CONFIG_DIR` into a temp dir, so no test reads or writes `~/.config/wip`, `~/.local/share/wip`, `~/.cache/wip` or `~/.claude.json`. It also blocks `fetch` to any non-loopback host (unless `POLLY_RECORD=true`): a GitHub call without a Polly recording rejects at once instead of reaching the real network, whose stalls used to hang a test and its teardown.
- **In-memory SQLite**: Call `initDb(":memory:")` in `beforeEach` and `resetDb()` in `afterEach`. Each test gets a fresh database with no disk I/O.
- **File-based debug DB**: Set `TEST_DB_FILE` to persist the database to a file for inspection:
    ```
    TEST_DB_FILE=/tmp/debug.db vitest run -t "test name"
    sqlite3 /tmp/debug.db '.tables'
    ```
- **Polly.js recordings**: HTTP fixtures are committed to `packages/shared/src/__recordings__/`. Set `POLLY_RECORD=true` to capture new fixtures (requires valid `gh auth` or `GITHUB_TOKEN`).
- **GitHubClient test mode**: Call `setGitHubClient(createTestClient())` to use a client with no auth. Polly.js intercepts fetch at the network level and replays from recordings.
- **Server function tests**: Import functions directly, seed the DB and project cache. No HTTP server needed.

### Git Fixture System

- **Recording/replay for git subprocesses**: `setupGitFixtures(testName)` in `packages/shared/src/test/git-fixtures.ts` intercepts `tracedExeca` calls and returns recorded output. Fixtures are stored in `packages/shared/src/__fixtures__/git/`.
- **Recording mode**: Set `GIT_FIXTURE_RECORD=true` to capture new git CLI output as JSON fixture files (hashed by command + args + stdin).
- **createTestGitRepo helper**: Creates a temporary git repo with `git init`, user config, and a remote. Used in `git.test.ts` for tests that need a real git repository (e.g., `isDirty`, `isDetachedHead`, `getChildren`).

### Handler Extraction Pattern

- **Testing createServerFn wrappers**: Extract the handler logic into a standalone exported `async function` (e.g., `getProjectChildrenHandler`, `pushChildHandler`) and have the `createServerFn().handler()` delegate to it. Tests import and call the handler directly, avoiding the TanStack Start framework wrapper.

### DOM Tests

- **jsdom click tests**: Add `// @vitest-environment jsdom` as the first line of a `packages/web` test file, then use `render`/`fireEvent`/`screen` from `@testing-library/react` with `cleanup()` in `afterEach`; see `packages/web/src/dom-smoke.test.tsx`. Other tests stay in the node environment.

### Landing End-to-End Harness

- `just e2e-landing` builds, then runs `packages/web/e2e/landing.e2e.mjs`: it clicks through the landing cards on `/queue` (cards in `queue-section-<category>`, e.g. `queue-section-ready_to_push`) in headless Chromium (Playwright) so landing flows are tested by script, not by hand. Run it after changing the landing columns, Open PR, Fast-forward main or Push main.
- `landing-world.mjs` builds a temp world: bare `acme/<repo>` upstreams and `e2e-user/<repo>` forks, clones with branches that are ready, go behind upstream, have a PR waiting for checks, sit on a red upstream (the test is `test ! -e RED`), or break the test so the buffer auto-fixes them (bolts), plus widgets' `lost-feature` (only on the fork, no PR: Remote only) and `covered-feature` (only on the fork, but upstream's `refs/pull/90/head` covers it; every clone fetches `refs/pull/*/head` into `<remote>/pr/*` except vaults, which gets the one Set up PR refs item), plus `vaults`, private, whose upstream check GitHub never started (billing), plus `levers`, whose upstream `other-org/levers` is foreign (not the user's login nor an `ownership.orgs` org) and red, with a test that names each failure (`--- FAIL: RED`): one commit adds no failure, one adds `NEWRED`, plus a WIP config and registry. `HOME`, the XDG dirs and `WIP_DB_PATH` point into the temp dir, and fake `gh`, `claude`, `mise` and `pmset` come first on `PATH`, and `HERDR_SOCKET_PATH` points at `fake-herdr.mjs` (a Unix-socket stand-in that runs a launched tab's command with `sh -c` and reports its agent done); the fake `claude` answers only `/build:fix ... --fixup=<sha>` (deletes `RED`, commits `fixup! <subject>`), and the world's `HOME/.claude.json` trusts bolts' clone so its agent launches; its env pins `core.fsmonitor=false` (`GIT_CONFIG_COUNT`), so no repo in it starts a git fsmonitor daemon, and the run fails if one is left watching the world; it never touches `~/.config/wip`, the real `wip.db`, real repos, real gh or real remotes.
- `fake-github.mjs` answers wip's GraphQL (`WIP_GITHUB_GRAPHQL_URL` points the server at it) and serves stand-in PR and new-PR (compare) pages (`WIP_GITHUB_WEB_URL` points wip's GitHub web links at it); a repo it gives `viewerPermission: "READ"` refuses a PR from its own branch, like GitHub. A repo with `baseCheck: "NOT_STARTED"` has a failed upstream check run that resolves (`nodes(ids:)`) to no steps and the billing annotation: GitHub never started it, so wip counts it as no CI result. `setCheckRuns(repo, sha, statuses)` sets the check run statuses the GitHub Actions gate reads on a pushed commit (none by default). `fake-gh.mjs` records every gh call. The browser may reach only the wip server and the fake GitHub.
- Flows: upstream red first (`/queue` shows exactly one `upstream-red-item`, for broken, naming "local baseline test failed" with `/build:fix` and how long it has been red; broken's commit cards show "Blocked: broken's upstream is red" and Ready to Land holds none of them, not even one green on the red tip), then Remote only (widgets' lost commit shows Remote only with Restore branch, Open PR and Delete remote branch, never in Ready to Land; the PR-covered one shows no card) and Set up PR refs on vaults (the click adds the refspec and the item leaves; headings run Set Up PR Refs, Upstream Red, Remote Only, Checks Running, Ready to Land), then foreign red upstream as baseline (levers gets no item; its no-new-failure commit lines up in Ready to Land with Open PR and no blocked marker although its own run is bad, its regressing commit never does; both branches are deleted before the restart), then a check GitHub never started (private `vaults`, whose `acme/vaults` upstream check the fake GitHub reports as a failure with no steps and the billing annotation: wip asks about that run, vaults gets no item or Blocked marker, its commit lines up by its local test, and before the restart, while the server still runs, its branch is deleted locally and from the fork, so the restarted server does not count it from cached children), then auto-fix (bolts' commit adds `RED`; the buffer's test fix launches the fake claude through the fake herdr in a throwaway worktree, its commit card shows "auto-fixed: <failure>", Review fix shows the fixup's diff, Accept squashes it into one green commit with the original's parent, author and message, which lists in Ready to Land while the pre-squash red card leaves /queue at once (children ignore commits only wip's test worktree or throwaway worktrees still hold, `heldOnlyByWipWorktrees` in `packages/shared/src/lib/git.ts`), then lands upstream so the restart's target of 1 counts only sprockets), Open PR on a Ready to Land card (the confirm opens `/opening/<id>`, which reaches the fake PR; no card moves while it runs, then the card moves to Checks Running, waiting for checks, and its outcome shows once, on that card), Open PR on a card upstream moved past (rebased and retested before pushing), Open PR on `gears` (no fork, token read-only on `acme/gears`, `verify: "draft-pr"` that the Ready to Land header reports ineligible: git pushes the branch, no PR is opened through the API, and the tab lands on the fake compare page), Fast-forward main, Push main, then the GitHub Actions gate (pulleys, winches and cranks start with no branches and the harness adds one commit at a time: pulleys' background push lands on its fork and the fake GitHub reports its check `QUEUED`, so winches' push, the same owner acme, is held with "GitHub Actions queued on acme/pulleys@<sha>" in server.log's "Ready-buffer push" line and never reaches its fork, while other-org's cranks pushes at once; once the check is `COMPLETED` the pusher's retry pushes winches; all three branches are deleted before the restart), then a restart on the same world (ready target 1), with vaults' branch deleted (local and fork) while the server was down (the restart compares each repo's refs with those its cached children were read from, so it must drop that commit), where cogs' row lands upstream before any page opens (the restarted server must drop it from cogs' children in the world DB: background refresh, the git watcher and the ready buffer start at server boot, not on the first `/api/events` connect) and gears' row lands next, after which upstream moves past the one green card left: it must leave Ready to Land (Needs Rebase), and the buffer rebases and retests it until it is listed again at its up-to-date tip, where Open PR opens its PR. It asserts on the bare repos' refs, the fake GitHub's PRs, the recorded gh calls, and server.log's `git test run` lines: in broken the buffer tested only its red upstream tip (to learn it is red) and none of its commits, while every other repo's commits were tested.
- The harness starts its wip server with `startProcessTree` (`e2e/server-process.mjs`): its own process group, killed on pass, failure, `process.exit` and SIGINT/SIGTERM/SIGHUP, and the run fails if anything still holds the world's `wip.db`.
- It logs the /queue page's JS heap, DOM nodes and listeners at each step, and when a Chromium renderer crashes ("Target crashed") it names the page and step and prints the macOS crash reports the run produced (`e2e/browser-crash.mjs`, from `~/Library/Logs/DiagnosticReports`).
- `WIP_E2E_KEEP=true` keeps the temp world (always kept on failure, with `queue-page.txt`, the /queue page's main text when the step failed, and `server.log`: the server runs with `WIP_SUBPROCESS_LOGGING=true`, so it holds one JSON line per subprocess (`tracedExeca` logs every one with cwd, exit code and stderr on failure) and general log entry); `WIP_E2E_HEADED=true` shows the browser. It runs Playwright's full Chromium in new headless mode (`playwright install chromium`; `WIP_E2E_CHANNEL=chromium-headless-shell` switches back to the headless shell, whose renderer segfaulted in about one run in four); on a renderer crash it names the crashed page and step and prints the run's macOS crash reports, waiting up to 10s for macOS to write one.

### Running Tests

- `just test` -- runs all tests with in-memory SQLite and Polly replay
- `TEST_DB_FILE=/tmp/debug.db just test` -- persists DB to file for inspection
- `POLLY_RECORD=true just test` -- re-records GitHub API fixtures (requires valid `gh auth` or `GITHUB_TOKEN`)
- `GIT_FIXTURE_RECORD=true just test` -- re-records git subprocess fixtures

## Code Style

- Tab indentation (width 4); YAML uses 2-space indentation
- Double quotes for strings
- Imports use `.js` extensions (TypeScript with ESM)
