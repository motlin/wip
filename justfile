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

# Build all packages
[group('build')]
build:
    pnpm run build

# Build the shared package only
[group('build')]
build-shared:
    pnpm --filter @wip/shared build

# Typecheck all packages
[group('build')]
typecheck:
    pnpm run typecheck

# Run tests
[group('test')]
test: build
    pnpm -r run test

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
