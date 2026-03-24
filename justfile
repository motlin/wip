set unstable
set allow-duplicate-recipes

wip := "./packages/cli/bin/run.js"

# List available recipes
[no-exit-message]
[group('default')]
default:
    @just --list --unsorted

# Install pnpm dependencies
[group('setup')]
install:
    pnpm install

# Install pnpm dependencies (CI, frozen lockfile)
[group('setup')]
install-ci:
    pnpm install --frozen-lockfile

# Build all packages
[group('build')]
build: install
    pnpm run build

# Build all packages (CI)
[group('build')]
build-ci: install-ci
    pnpm run build

# Build the shared package only
[group('build')]
build-shared: install
    pnpm --filter @wip/shared build

# Build the shared package only (CI)
[group('build')]
build-shared-ci: install-ci
    pnpm --filter @wip/shared build

# Typecheck all packages
[group('build')]
typecheck: install
    pnpm run typecheck

# Typecheck all packages (CI, builds first to generate routeTree.gen.ts)
[group('build')]
typecheck-ci: build-ci
    pnpm run typecheck

# Run tests
[group('test')]
test: build
    pnpm -r run test

# Run tests (CI)
[group('test')]
test-ci: build-ci
    pnpm -r run test

# Run all pre-commit checks
[group('build')]
precommit: build typecheck test
    @echo "All pre-commit checks passed!"

# Start web dashboard dev server
[group('web')]
dev: build-shared
    pnpm --filter @wip/web dev

# Start web dashboard (production build)
[group('web')]
serve: build
    {{wip}} serve

# `sqlite3 ~/.local/share/wip/wip.db`
[group('database')]
db-cli:
    sqlite3 ~/.local/share/wip/wip.db

# `datasette ~/.local/share/wip/wip.db`
[group('database')]
db-web:
    datasette ~/.local/share/wip/wip.db

# Show off every wip command
[group('demo')]
demo:
    @echo '============================='
    @echo '  wip children'
    @echo '============================='
    {{wip}} children
    @echo ''
    @echo '============================='
    @echo '  wip children --json'
    @echo '============================='
    {{wip}} children --json
    @echo ''
    @echo '============================='
    @echo '  wip results'
    @echo '============================='
    {{wip}} results
    @echo ''
    @echo '============================='
    @echo '  wip results --json'
    @echo '============================='
    {{wip}} results --json
    @echo ''
    @echo '============================='
    @echo '  wip report'
    @echo '============================='
    {{wip}} report
    @echo ''
    @echo '============================='
    @echo '  wip report --json'
    @echo '============================='
    {{wip}} report --json
    @echo ''
    @echo '============================='
    @echo '  wip report --summary'
    @echo '============================='
    {{wip}} report --summary
    @echo ''
    @echo '============================='
    @echo '  wip report --quiet'
    @echo '============================='
    {{wip}} report --quiet
    @echo ''
    @echo '============================='
    @echo '  wip config get'
    @echo '============================='
    {{wip}} config get
    @echo ''
    @echo '============================='
    @echo '  wip config get --json'
    @echo '============================='
    {{wip}} config get --json
    @echo ''
    @echo '============================='
    @echo '  wip test --dry-run'
    @echo '============================='
    {{wip}} test --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip test --dry-run --json'
    @echo '============================='
    {{wip}} test --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip push --dry-run'
    @echo '============================='
    {{wip}} push --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip push --dry-run --json'
    @echo '============================='
    {{wip}} push --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip config set projectsDir ~/projects --dry-run'
    @echo '============================='
    {{wip}} config set projectsDir ~/projects --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip config set projectsDir ~/projects --dry-run --json'
    @echo '============================='
    {{wip}} config set projectsDir ~/projects --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip config unset projectsDir --dry-run'
    @echo '============================='
    {{wip}} config unset projectsDir --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip config unset projectsDir --dry-run --json'
    @echo '============================='
    {{wip}} config unset projectsDir --dry-run --json
