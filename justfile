wip := "./packages/cli/bin/run.js"

# `just --list --unsorted`
[group('default')]
[no-exit-message]
default:
    @just --list --unsorted

ci := env("CI", "")

export PATH := justfile_directory() / "node_modules/.bin" + ":" + env("PATH")

# Install dependencies
[group('setup')]
install:
    pnpm install
    just ensure-sqlite-native
    vp fmt CLAUDE.md

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
        vp exec pnpm --dir "$package_dir" run build-release
        node -e 'const Database = require(process.argv[1]); new Database(":memory:").close();' "$package_dir"
    done

# Build all packages
[group('build')]
build: install
    vp run --cache build

# vp exec pnpm --filter @wip/shared build
[group('build')]
build-shared: install
    vp exec pnpm --filter @wip/shared build

# Run linter
[group('build')]
lint: install
    vp lint {{ if ci != "" { "--format github" } else { "--fix" } }}

# Run formatter
[group('build')]
format: install
    pre-commit run just-fmt --all-files
    vp fmt {{ if ci != "" { "--check" } else { "" } }}

# Run checks (format + lint + typecheck)
[group('build')]
check *args: build
    vp run --cache check {{ if ci != "" { "" } else { "--fix" } }} {{ args }}

# Type-check the project
[group('build')]
typecheck: build
    vp run typecheck

# Run tests
[group('test')]
test *args: build
    vp run --cache test:run {{ args }}

# Apply safe Fallow fixes locally, then reject remaining dead code
[group('build')]
fallow: install
    {{ if ci == "" { "vp run fallow" } else { "true" } }}
    vp run fallow:ci

# vp run fallow:ci
[group('build')]
fallow-check: install
    vp run fallow:ci

# Run Storybook
[group('web')]
storybook *args: install
    vp run --filter @wip/web storybook {{ args }}

# Run pre-commit hooks on all files (same as CI's pre-commit job)
[group('build')]
pre-commit: install
    pre-commit run --all-files

# Run all pre-commit checks
[arg("quick", long, value="true", help="Skip tests")]
[group('build')]
verify quick="": check build fallow pre-commit
    {{ if quick != "true" { "just test" } else { "true" } }}
    @echo "All pre-commit checks passed!"

# Deprecated alias for `verify`
[arg("quick", long, value="true", help="Skip tests")]
[group('build')]
precommit quick="": (verify quick)

# Run dev server
[group('web')]
dev *args: build-shared
    vp exec pnpm --filter @wip/web dev {{ args }}

# Start web dashboard (production build)
[group('web')]
serve: build
    {{ wip }} serve

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
    {{ wip }} children
    @echo ''
    @echo '============================='
    @echo '  wip children --json'
    @echo '============================='
    {{ wip }} children --json
    @echo ''
    @echo '============================='
    @echo '  wip results'
    @echo '============================='
    {{ wip }} results
    @echo ''
    @echo '============================='
    @echo '  wip results --json'
    @echo '============================='
    {{ wip }} results --json
    @echo ''
    @echo '============================='
    @echo '  wip report'
    @echo '============================='
    {{ wip }} report
    @echo ''
    @echo '============================='
    @echo '  wip report --json'
    @echo '============================='
    {{ wip }} report --json
    @echo ''
    @echo '============================='
    @echo '  wip report --summary'
    @echo '============================='
    {{ wip }} report --summary
    @echo ''
    @echo '============================='
    @echo '  wip report --quiet'
    @echo '============================='
    {{ wip }} report --quiet
    @echo ''
    @echo '============================='
    @echo '  wip config get'
    @echo '============================='
    {{ wip }} config get
    @echo ''
    @echo '============================='
    @echo '  wip config get --json'
    @echo '============================='
    {{ wip }} config get --json
    @echo ''
    @echo '============================='
    @echo '  wip test --dry-run'
    @echo '============================='
    {{ wip }} test --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip test --dry-run --json'
    @echo '============================='
    {{ wip }} test --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip push --dry-run'
    @echo '============================='
    {{ wip }} push --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip push --dry-run --json'
    @echo '============================='
    {{ wip }} push --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip config set projectsDir ~/projects --dry-run'
    @echo '============================='
    {{ wip }} config set projectsDir ~/projects --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip config set projectsDir ~/projects --dry-run --json'
    @echo '============================='
    {{ wip }} config set projectsDir ~/projects --dry-run --json
    @echo ''
    @echo '============================='
    @echo '  wip config unset projectsDir --dry-run'
    @echo '============================='
    {{ wip }} config unset projectsDir --dry-run
    @echo ''
    @echo '============================='
    @echo '  wip config unset projectsDir --dry-run --json'
    @echo '============================='
    {{ wip }} config unset projectsDir --dry-run --json
