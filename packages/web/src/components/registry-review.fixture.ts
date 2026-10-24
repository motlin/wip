import type {RegistryCandidate} from "@wip/shared";

/** The unregistered rows of the real candidate list GET from the server on 2026-10-24, when Skip all git worktrees left Factorio-FBSR-maven-3.10.0 behind. */
export const realUnregistered: RegistryCandidate[] = [
	{
		project: {name: "Brewfile", dir: "/Users/craig/projects/Brewfile", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "Factorio-FBSR", dir: "/Users/craig/projects/Factorio-FBSR", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "Factorio-FBSR-maven-3.10.0",
			dir: "/Users/craig/projects/Factorio-FBSR-maven-3.10.0",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "maven", text: "Maven 3.10.0 copy of Factorio-FBSR"},
	},
	{
		project: {
			name: "aggregator-creator",
			dir: "/Users/craig/projects/aggregator-creator",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "avalon-online-logs-pr125",
			dir: "/Users/craig/projects/avalon-online-logs-pr125",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "pr", text: "PR #125 worktree of avalon-online-logs"},
	},
	{
		project: {name: "caveman", dir: "/Users/craig/projects/caveman", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "ccp-par-1", dir: "/Users/craig/projects/ccp-par-1", template: "typescript", kind: "skip"},
		group: "unregistered",
		skipReason: {code: "parallel", text: "parallel worktree of ccp"},
	},
	{
		project: {name: "ccp-par-2", dir: "/Users/craig/projects/ccp-par-2", template: "typescript", kind: "skip"},
		group: "unregistered",
		skipReason: {code: "parallel", text: "parallel worktree of ccp"},
	},
	{
		project: {name: "ccp-par-3", dir: "/Users/craig/projects/ccp-par-3", template: "typescript", kind: "skip"},
		group: "unregistered",
		skipReason: {code: "parallel", text: "parallel worktree of ccp"},
	},
	{
		project: {
			name: "claude-code-telemetry",
			dir: "/Users/craig/projects/claude-code-telemetry",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "clean", dir: "/Users/craig/projects/clean", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "data-converter",
			dir: "/Users/craig/projects/data-converter",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of factorio.school"},
	},
	{
		project: {
			name: "decompile-workflowy",
			dir: "/Users/craig/projects/decompile-workflowy",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "demo", dir: "/Users/craig/projects/demo", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "development-setup",
			dir: "/Users/craig/projects/development-setup",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "drafts", dir: "/Users/craig/projects/drafts", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "eclipse-collections-fix-untouchable-list-wrapping",
			dir: "/Users/craig/projects/eclipse-collections-fix-untouchable-list-wrapping",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-guava-testlib",
			dir: "/Users/craig/projects/eclipse-collections-guava-testlib",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-review-detectLastIndex",
			dir: "/Users/craig/projects/eclipse-collections-review-detectLastIndex",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-review-fix-stack",
			dir: "/Users/craig/projects/eclipse-collections-review-fix-stack",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-review-ordered-set",
			dir: "/Users/craig/projects/eclipse-collections-review-ordered-set",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-review-sync-ordered-map",
			dir: "/Users/craig/projects/eclipse-collections-review-sync-ordered-map",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-sorted-set-first-last",
			dir: "/Users/craig/projects/eclipse-collections-sorted-set-first-last",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "eclipse-collections-unmodifiable-map-defaults",
			dir: "/Users/craig/projects/eclipse-collections-unmodifiable-map-defaults",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of eclipse-collections"},
	},
	{
		project: {
			name: "factorio-blueprint-firebase-cdn",
			dir: "/Users/craig/projects/factorio-blueprint-firebase-cdn",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio-blueprint-json-cdn",
			dir: "/Users/craig/projects/factorio-blueprint-json-cdn",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio-blueprint-key-cdn",
			dir: "/Users/craig/projects/factorio-blueprint-key-cdn",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio-icon-cdn",
			dir: "/Users/craig/projects/factorio-icon-cdn",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio-saved-game-data",
			dir: "/Users/craig/projects/factorio-saved-game-data",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio-speedrun",
			dir: "/Users/craig/projects/factorio-speedrun",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "factorio.school-maven-3.10.0",
			dir: "/Users/craig/projects/factorio.school-maven-3.10.0",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "maven", text: "Maven 3.10.0 copy of factorio.school"},
	},
	{
		project: {
			name: "factorio.school-pr-574",
			dir: "/Users/craig/projects/factorio.school-pr-574",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of factorio.school"},
	},
	{
		project: {
			name: "factorio.school-pr-581",
			dir: "/Users/craig/projects/factorio.school-pr-581",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of factorio.school"},
	},
	{
		project: {
			name: "factorio.school-pr-590",
			dir: "/Users/craig/projects/factorio.school-pr-590",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of factorio.school"},
	},
	{
		project: {
			name: "factorio.school-pr-632",
			dir: "/Users/craig/projects/factorio.school-pr-632",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of factorio.school"},
	},
	{
		project: {name: "flipper", dir: "/Users/craig/projects/flipper", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "forbid-merge-commits-action",
			dir: "/Users/craig/projects/forbid-merge-commits-action",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "forbid-merge-commits-action-pr30",
			dir: "/Users/craig/projects/forbid-merge-commits-action-pr30",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "pr", text: "PR #30 worktree of forbid-merge-commits-action"},
	},
	{
		project: {name: "git-test", dir: "/Users/craig/projects/git-test", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "git-test-results-commits-pr75",
			dir: "/Users/craig/projects/git-test-results-commits-pr75",
			template: "rust",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "pr", text: "PR #75 worktree of git-test-results-commits"},
	},
	{
		project: {
			name: "herdr-shell-status",
			dir: "/Users/craig/projects/herdr-shell-status",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "herdr-web", dir: "/Users/craig/projects/herdr-web", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "hex-flip", dir: "/Users/craig/projects/hex-flip", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "impress-claude-code",
			dir: "/Users/craig/projects/impress-claude-code",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "investments", dir: "/Users/craig/projects/investments", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "janesterlist.com",
			dir: "/Users/craig/projects/janesterlist.com",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "java-template",
			dir: "/Users/craig/projects/java-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {
			name: "jetbrains-settings",
			dir: "/Users/craig/projects/jetbrains-settings",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "jlox-remove-audit-just-options-script",
			dir: "/Users/craig/projects/jlox-remove-audit-just-options-script",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of jlox"},
	},
	{
		project: {name: "jperm", dir: "/Users/craig/projects/jperm", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "kalshi-test-worktree",
			dir: "/Users/craig/projects/kalshi-test-worktree",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of kalshi"},
	},
	{
		project: {
			name: "klass-intellij-plugin-sync-java-template",
			dir: "/Users/craig/projects/klass-intellij-plugin-sync-java-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {
			name: "klass-java-template-sync",
			dir: "/Users/craig/projects/klass-java-template-sync",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of klass"},
	},
	{
		project: {
			name: "klass-openrewrite-violations",
			dir: "/Users/craig/projects/klass-openrewrite-violations",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of klass"},
	},
	{
		project: {
			name: "klass-prism-pr22",
			dir: "/Users/craig/projects/klass-prism-pr22",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "pr", text: "PR #22 worktree of klass-prism"},
	},
	{
		project: {
			name: "klass-reuse-compiler-token-categories",
			dir: "/Users/craig/projects/klass-reuse-compiler-token-categories",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of klass"},
	},
	{
		project: {
			name: "klass-split-lines-only-on-error",
			dir: "/Users/craig/projects/klass-split-lines-only-on-error",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of klass"},
	},
	{
		project: {
			name: "klass-two-stage-sll-parsing",
			dir: "/Users/craig/projects/klass-two-stage-sll-parsing",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of klass"},
	},
	{
		project: {
			name: "liftwizard-openrewrite-codegenome",
			dir: "/Users/craig/projects/liftwizard-openrewrite-codegenome",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of liftwizard"},
	},
	{
		project: {name: "logback", dir: "/Users/craig/projects/logback", template: "java", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "logback-ordered-mdc",
			dir: "/Users/craig/projects/logback-ordered-mdc",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of logback"},
	},
	{project: {name: "lox", dir: "/Users/craig/projects/lox", template: "java", kind: "own"}, group: "unregistered"},
	{
		project: {
			name: "maven-surefire-isolation",
			dir: "/Users/craig/projects/maven-surefire-isolation",
			template: "java",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "motlin.github.io",
			dir: "/Users/craig/projects/motlin.github.io",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "neighbors", dir: "/Users/craig/projects/neighbors", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "nextdns", dir: "/Users/craig/projects/nextdns", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{project: {name: "obs", dir: "/Users/craig/projects/obs", template: "unknown", kind: "own"}, group: "unregistered"},
	{
		project: {
			name: "oxc-next-line",
			dir: "/Users/craig/projects/oxc-next-line",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "parent", dir: "/Users/craig/projects/parent", template: "java", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "parent-maven-3.10.0",
			dir: "/Users/craig/projects/parent-maven-3.10.0",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "maven", text: "Maven 3.10.0 copy of parent"},
	},
	{
		project: {
			name: "playdate-template",
			dir: "/Users/craig/projects/playdate-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {
			name: "presentations-zizmor-pr",
			dir: "/Users/craig/projects/presentations-zizmor-pr",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "prettier-java-next-line",
			dir: "/Users/craig/projects/prettier-java-next-line",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "prettier-next-line",
			dir: "/Users/craig/projects/prettier-next-line",
			template: "typescript",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "private-binaries",
			dir: "/Users/craig/projects/private-binaries",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {name: "private-blog", dir: "/Users/craig/projects/private-blog", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "project-template",
			dir: "/Users/craig/projects/project-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {name: "promotion", dir: "/Users/craig/projects/promotion", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "prompts", dir: "/Users/craig/projects/prompts", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {name: "quarto", dir: "/Users/craig/projects/quarto", template: "typescript", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "quarto-remove-audit-just-options-script",
			dir: "/Users/craig/projects/quarto-remove-audit-just-options-script",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of quarto"},
	},
	{
		project: {name: "rewrite", dir: "/Users/craig/projects/rewrite", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "rewrite-cucumber-jvm",
			dir: "/Users/craig/projects/rewrite-cucumber-jvm",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "rewrite-measure-lazy",
			dir: "/Users/craig/projects/rewrite-measure-lazy",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-measure-shared",
			dir: "/Users/craig/projects/rewrite-measure-shared",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-migrate-java",
			dir: "/Users/craig/projects/rewrite-migrate-java",
			template: "unknown",
			kind: "own",
		},
		group: "unregistered",
	},
	{
		project: {
			name: "rewrite-perf-lazy-stacked",
			dir: "/Users/craig/projects/rewrite-perf-lazy-stacked",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-perf-parse-repo-harness",
			dir: "/Users/craig/projects/rewrite-perf-parse-repo-harness",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-perf-pr-shared-classpath-types",
			dir: "/Users/craig/projects/rewrite-perf-pr-shared-classpath-types",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-perf-pr-sig-measure-base",
			dir: "/Users/craig/projects/rewrite-perf-pr-sig-measure-base",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-perf-pr-sig-measure-cand",
			dir: "/Users/craig/projects/rewrite-perf-pr-sig-measure-cand",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-perf-pr-signature-builder",
			dir: "/Users/craig/projects/rewrite-perf-pr-signature-builder",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-lazy-probe",
			dir: "/Users/craig/projects/rewrite-verify-lazy-probe",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-lazy-probe-base",
			dir: "/Users/craig/projects/rewrite-verify-lazy-probe-base",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-lazy2",
			dir: "/Users/craig/projects/rewrite-verify-lazy2",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-lazy2-base",
			dir: "/Users/craig/projects/rewrite-verify-lazy2-base",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-lazy3",
			dir: "/Users/craig/projects/rewrite-verify-lazy3",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-micro-base",
			dir: "/Users/craig/projects/rewrite-verify-micro-base",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rewrite-verify-micro-cand",
			dir: "/Users/craig/projects/rewrite-verify-micro-cand",
			template: "unknown",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of rewrite"},
	},
	{
		project: {
			name: "rust-template",
			dir: "/Users/craig/projects/rust-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {name: "takedown", dir: "/Users/craig/projects/takedown", template: "unknown", kind: "own"},
		group: "unregistered",
	},
	{
		project: {
			name: "typescript-template",
			dir: "/Users/craig/projects/typescript-template",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "template", text: "template repo"},
	},
	{
		project: {
			name: "workflowy-java-pr126",
			dir: "/Users/craig/projects/workflowy-java-pr126",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "pr", text: "PR #126 worktree of workflowy-java"},
	},
	{
		project: {
			name: "yepnope-remove-audit-just-options-script",
			dir: "/Users/craig/projects/yepnope-remove-audit-just-options-script",
			template: "typescript",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of yepnope"},
	},
	{
		project: {
			name: "znai-mise-runtimes",
			dir: "/Users/craig/projects/znai-mise-runtimes",
			template: "java",
			kind: "skip",
		},
		group: "unregistered",
		skipReason: {code: "worktree", text: "git worktree of znai"},
	},
];
