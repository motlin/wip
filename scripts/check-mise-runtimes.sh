#!/usr/bin/env bash

set -Eeuo pipefail

# Fail when a language runtime this repository's tooling needs is not pinned in its mise config.
# An unpinned runtime falls through to whatever global copy is on PATH, like Homebrew's python3 or node.
# This is not limited to the repository's own language: pre-commit runs on Python, and Prettier,
# markdownlint, and vite-plus run on Node, so a Java or Rust repository needs those pinned too.

cd "$(git rev-parse --show-toplevel)"

required=()

has_tracked() {
	[[ -n "$(git ls-files -- "$@")" ]]
}

if has_tracked .pre-commit-config.yaml '*.py'; then
	required+=(python3)
fi
if has_tracked package.json || grep -qs '^"npm:' .mise/config.toml; then
	required+=(node)
fi
if has_tracked pom.xml '*/pom.xml' build.gradle build.gradle.kts mvnw; then
	required+=(java)
fi
if has_tracked Cargo.toml; then
	required+=(cargo)
fi
if has_tracked bun.lock bun.lockb; then
	required+=(bun)
fi

missing=()
for runtime in "${required[@]}"; do
	if ! mise which "${runtime}" >/dev/null 2>&1; then
		missing+=("${runtime}")
	fi
done

if ((${#missing[@]} > 0)); then
	echo "These runtimes are used here but not pinned in the mise config: ${missing[*]}" >&2
	echo "Pin each one in .mise/config.toml so nothing falls back to a global install on PATH." >&2
	exit 1
fi
