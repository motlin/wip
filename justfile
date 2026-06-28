set unstable
set allow-duplicate-recipes

wip := "./packages/cli/bin/run.js"

ci := env("CI", "")

# List available recipes
[no-exit-message]
[group('default')]
default:
    @just --list --unsorted

# Install dependencies
[group('setup')]
install:
    vp install
    just ensure-sqlite-native

# Verify better-sqlite3 native modules match the active Node runtime
[group('setup')]
ensure-sqlite-native:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d node_modules/.pnpm ]; then
        exit 0
    fi
    find node_modules/.pnpm -path "*/node_modules/better-sqlite3/package.json" -print | sort | while IFS= read -r package_json; do
        package_dir="$PWD/$(dirname "$package_json")"
        if node -e 'const Database = require(process.argv[1]); new Database(":memory:").close();' "$package_dir" >/dev/null 2>&1; then
            continue
        fi
        rm -rf "$package_dir/build"
        pnpm --dir "$package_dir" run build-release
        node -e 'const Database = require(process.argv[1]); new Database(":memory:").close();' "$package_dir"
    done

# Build all packages
[group('build')]
build: install
    pnpm run build

[group('build')]
build-ci: build

# Build the shared package only
[group('build')]
build-shared: install
    pnpm --filter @wip/shared build

# Run linter
[group('build')]
lint: install
    vp lint {{ if ci != "" { "--format github" } else { "--fix" } }}

# Run formatter
[group('build')]
format: install
    vp fmt {{ if ci != "" { "--check" } else { "" } }}

# Run checks (format + lint + typecheck)
[group('build')]
check: install
    vp check {{ if ci != "" { "" } else { "--fix" } }}

# Typecheck all packages
[group('build')]
typecheck: build
    pnpm run typecheck

[group('build')]
typecheck-ci: build

# Run tests
[group('test')]
test: build
    pnpm -r run test

[group('test')]
test-ci: test

# Run all pre-commit checks
[group('build')]
precommit: check build typecheck test
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
