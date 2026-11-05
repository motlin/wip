# CLAUDE.md

## Project Overview

`wip` is a monorepo managed with pnpm workspaces and built with the Vite+ toolchain. It has three packages:

- `packages/shared` (`@wip/shared`) -- shared library with database layer, GitHub API client, and git operations
- `packages/web` (`@wip/web`) -- TanStack Start web dashboard
- `packages/cli` (`@wip/cli`) -- CLI tool

## Design Principles

- wip is Toyota/lean WIP reduction: finish small, independent work instead of advancing everything. The unit is the commit.
- Ready to land = up to date with upstream + green, the "Ready to Push (tested + rebased)" state of the `docs/work-stages.md` state machine, where the rebase and test tracks converge. A commit behind upstream is Needs Rebase, on the item page, the kanban and Ready to land alike.
- Keep 2-3 commits fully ready (the ready target) and advance lazily, by priority: after a restart or an upstream move, the ready count is recomputed from up-to-date green commits only, and the buffer rebases and retests the highest-priority candidates until the target is met again.
- Never list or count a behind commit as ready.

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
- Draft-PR verification is opt-in per repo: `verify: "draft-pr"` on its entry in `~/.config/wip/projects.json5` (`draftPrVerification` in `packages/shared/src/lib/inventory.ts`). With `landing: "pull-request"` also set explicitly, a public PR target (`prRepository`) and a workflow on the upstream branch that runs on `pull_request`, the ready buffer runs no local `git test` for that repo (baseline included): it force-pushes each commit with lease to its origin branch, opens one draft PR per branch (reused across rebases), and its GitHub checks decide green or checks failed. Draft PRs awaiting checks count toward the ready target, a push the GitHub Actions gate holds retries after 60s, and Open PR on such a row marks the draft ready (`gh pr ready`) and turns on auto-merge where allowed. A private repo, one without `pull_request` workflows, one without explicit pull-request landing, or one where the GitHub token can't open the PRs (head branch in the PR repo itself and the token's `viewerPermission` there below WRITE; a fork's head needs only read; `prTokenShortfall` in `packages/shared/src/lib/github-viewer-permission.ts`) keeps local tests, and Ready to land says why. Open PR on such a token-short repo still pushes with git, then sends the tab to GitHub's prefilled new-PR (compare) page instead of opening the PR through the API.
- Background `git test run`s (ready buffer, Push main pre-testing) run under `nice -n 10` with `VITEST_MAX_WORKERS` / `WIP_BACKGROUND_JOBS` set from config key `background.testWorkers` (default 2); user-initiated actions keep normal priority. On battery (`pmset -g batt`, read every 30s) the buffer starts nothing, `pauseOnBattery` jobs wait in the work queue, and Ready to land says "Paused on battery".

## Testing

### Patterns

- **Git environment**: `git-env-setup.ts` (every package's vitest setup) runs `sanitizeGitEnv`: inherited `GIT_*` variables are dropped, global/system git config is hidden, and `core.fsmonitor=false` is pinned via `GIT_CONFIG_COUNT`, so no temp repo starts a git fsmonitor daemon (leaked daemons exhaust macOS FSEvents).
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

- `just e2e-landing` builds, then runs `packages/web/e2e/landing.e2e.mjs`: it clicks through Ready to land on `/queue` in headless Chromium (Playwright) so landing flows are tested by script, not by hand. Run it after changing Ready to land, Open PR, Fast-forward main or Push main.
- `landing-world.mjs` builds a temp world: bare `acme/<repo>` upstreams and `e2e-user/<repo>` forks, clones with branches that are ready, go behind upstream, have a PR waiting for checks, or sit on a red upstream (the test is `test ! -e RED`), plus a WIP config and registry. `HOME`, the XDG dirs and `WIP_DB_PATH` point into the temp dir, and fake `gh`, `claude`, `mise` and `pmset` come first on `PATH`; its env pins `core.fsmonitor=false` (`GIT_CONFIG_COUNT`), so no repo in it starts a git fsmonitor daemon, and the run fails if one is left watching the world; it never touches `~/.config/wip`, the real `wip.db`, real repos, real gh or real remotes.
- `fake-github.mjs` answers wip's GraphQL (`WIP_GITHUB_GRAPHQL_URL` points the server at it) and serves stand-in PR and new-PR (compare) pages (`WIP_GITHUB_WEB_URL` points wip's GitHub web links at it); a repo it gives `viewerPermission: "READ"` refuses a PR from its own branch, like GitHub. `fake-gh.mjs` records every gh call. The browser may reach only the wip server and the fake GitHub.
- Flows: Open PR on a ready row (the confirm opens `/opening/<id>`, which reaches the fake PR; the row turns "PR #n · waiting for checks"; no row moves while it runs), Open PR on a row upstream moved past (rebased and retested before pushing), Open PR on `gears` (no fork, token read-only on `acme/gears`, `verify: "draft-pr"` that Ready to land reports ineligible: git pushes the branch, no PR is opened through the API, and the tab lands on the fake compare page), Fast-forward main, Push main, then a restart on the same world (ready target 1) where cogs' row lands upstream before any page opens (the restarted server must drop it from cogs' children in the world DB: background refresh, the git watcher and the ready buffer start at server boot, not on the first `/api/events` connect) and gears' row lands next, after which upstream moves past the one green row left: it must leave Ready to land, and the buffer rebases and retests it until it is listed again at its up-to-date tip, where Open PR opens its PR. It asserts on the bare repos' refs, the fake GitHub's PRs and the recorded gh calls.
- The harness starts its wip server with `startProcessTree` (`e2e/server-process.mjs`): its own process group, killed on pass, failure, `process.exit` and SIGINT/SIGTERM/SIGHUP, and the run fails if anything still holds the world's `wip.db`.
- `WIP_E2E_KEEP=true` keeps the temp world (always kept on failure, with `server.log`); `WIP_E2E_HEADED=true` shows the browser.

### Running Tests

- `just test` -- runs all tests with in-memory SQLite and Polly replay
- `TEST_DB_FILE=/tmp/debug.db just test` -- persists DB to file for inspection
- `POLLY_RECORD=true just test` -- re-records GitHub API fixtures (requires valid `gh auth` or `GITHUB_TOKEN`)
- `GIT_FIXTURE_RECORD=true just test` -- re-records git subprocess fixtures

## Code Style

- Tab indentation (width 4); YAML uses 2-space indentation
- Double quotes for strings
- Imports use `.js` extensions (TypeScript with ESM)
