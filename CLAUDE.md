# CLAUDE.md

## Project Overview

`wip` is a monorepo managed with pnpm workspaces and built with the Vite+ toolchain. It has three packages:

- `packages/shared` (`@wip/shared`) -- shared library with database layer, GitHub API client, and git operations
- `packages/web` (`@wip/web`) -- TanStack Start web dashboard
- `packages/cli` (`@wip/cli`) -- CLI tool

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
- Draft-PR verification is opt-in per repo: `verify: "draft-pr"` on its entry in `~/.config/wip/projects.json5` (`draftPrVerification` in `packages/shared/src/lib/inventory.ts`). With `landing: "pull-request"` also set explicitly, a public PR target (`prRepository`) and a workflow on the upstream branch that runs on `pull_request`, the ready buffer runs no local `git test` for that repo (baseline included): it force-pushes each commit with lease to its origin branch, opens one draft PR per branch (reused across rebases), and its GitHub checks decide green or checks failed. Draft PRs awaiting checks count toward the ready target, a push the GitHub Actions gate holds retries after 60s, and Open PR on such a row marks the draft ready (`gh pr ready`) and turns on auto-merge where allowed. A private repo, one without `pull_request` workflows, or one without explicit pull-request landing keeps local tests, and Ready to land says why.
- Background `git test run`s (ready buffer, Push main pre-testing) run under `nice -n 10` with `VITEST_MAX_WORKERS` / `WIP_BACKGROUND_JOBS` set from config key `background.testWorkers` (default 2); user-initiated actions keep normal priority. On battery (`pmset -g batt`, read every 30s) the buffer starts nothing, `pauseOnBattery` jobs wait in the work queue, and Ready to land says "Paused on battery".

## Testing

### Patterns

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
- `landing-world.mjs` builds a temp world: bare `acme/<repo>` upstreams and `e2e-user/<repo>` forks, clones with branches that are ready, go behind upstream, have a PR waiting for checks, or sit on a red upstream (the test is `test ! -e RED`), plus a WIP config and registry. `HOME`, the XDG dirs and `WIP_DB_PATH` point into the temp dir, and fake `gh`, `claude`, `mise` and `pmset` come first on `PATH`; it never touches `~/.config/wip`, the real `wip.db`, real repos, real gh or real remotes.
- `fake-github.mjs` answers wip's GraphQL (`WIP_GITHUB_GRAPHQL_URL` points the server at it) and serves stand-in PR pages; `fake-gh.mjs` records every gh call. The browser may reach only the wip server and the fake GitHub.
- Flows: Open PR on a ready row (the confirm opens `/opening/<id>`, which reaches the fake PR; the row turns "PR #n · waiting for checks"; no row moves while it runs), Open PR on a row upstream moved past (rebased and retested before pushing), Fast-forward main, Push main, then a restart on the same world (ready target 1, so nothing re-advances) after which upstream moves past a green row that must stay listed, marked behind, with Open PR. It asserts on the bare repos' refs, the fake GitHub's PRs and the recorded gh calls.
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
