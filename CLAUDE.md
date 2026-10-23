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

### Running Tests

- `just test` -- runs all tests with in-memory SQLite and Polly replay
- `TEST_DB_FILE=/tmp/debug.db just test` -- persists DB to file for inspection
- `POLLY_RECORD=true just test` -- re-records GitHub API fixtures (requires valid `gh auth` or `GITHUB_TOKEN`)
- `GIT_FIXTURE_RECORD=true just test` -- re-records git subprocess fixtures

## Code Style

- Tab indentation (width 4); YAML uses 2-space indentation
- Double quotes for strings
- Imports use `.js` extensions (TypeScript with ESM)
