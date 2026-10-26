import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const FAR_FUTURE = "9999-12-31 23:59:59";

export const branchNames = sqliteTable(
	"branch_names",
	{
		sha: text("sha").notNull(),
		project: text("project").notNull(),
		name: text("name").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.sha, table.project, table.systemTo]}),
		index("branch_names_active_idx").on(table.sha, table.project, table.systemTo),
	],
);

export const prStatusCache = sqliteTable(
	"pr_status_cache",
	{
		project: text("project").notNull(),
		branch: text("branch").notNull(),
		reviewStatus: text("review_status", {
			enum: ["clean", "approved", "changes_requested", "commented", "no_pr"],
		}).notNull(),
		checkStatus: text("check_status", {
			enum: ["pending", "running", "passed", "failed", "none", "unknown"],
		}).notNull(),
		prUrl: text("pr_url"),
		prNumber: integer("pr_number"),
		behind: integer("behind", {mode: "boolean"}).notNull().default(false),
		mergeStateStatus: text("merge_state_status"),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.branch, table.systemTo]}),
		index("pr_status_cache_active_idx").on(table.project, table.systemTo),
	],
);

export const prFailedChecks = sqliteTable(
	"pr_failed_checks",
	{
		project: text("project").notNull(),
		branch: text("branch").notNull(),
		systemFrom: text("system_from").notNull(),
		name: text("name").notNull(),
		url: text("url"),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.branch, table.systemTo, table.name]}),
		index("pr_failed_checks_active_idx").on(table.project, table.systemTo),
	],
);

export const reportCache = sqliteTable(
	"report_cache",
	{
		id: integer("id").notNull().default(1),
		data: text("data").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [primaryKey({columns: [table.id, table.systemTo]})],
);

export const miseEnvVars = sqliteTable(
	"mise_env_vars",
	{
		dir: text("dir").notNull(),
		systemFrom: text("system_from").notNull(),
		key: text("key").notNull(),
		value: text("value").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [primaryKey({columns: [table.dir, table.systemTo, table.key]})],
);

export const miseEnvCache = sqliteTable(
	"mise_env_cache",
	{
		dir: text("dir").notNull(),
		env: text("env").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.dir, table.systemTo]}),
		index("mise_env_cache_active_idx").on(table.dir, table.systemTo),
	],
);

export const ghLoginCache = sqliteTable(
	"gh_login_cache",
	{
		id: integer("id").notNull().default(1),
		login: text("login").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.id, table.systemTo]}),
		index("gh_login_cache_active_idx").on(table.systemTo),
	],
);

export const githubIssues = sqliteTable(
	"github_issues",
	{
		systemFrom: text("system_from").notNull(),
		number: integer("number").notNull(),
		title: text("title").notNull(),
		url: text("url").notNull(),
		repoName: text("repo_name").notNull(),
		repoNameWithOwner: text("repo_name_with_owner").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.systemTo, table.number, table.repoNameWithOwner]}),
		index("github_issues_active_idx").on(table.systemTo),
	],
);

export const githubIssueLabels = sqliteTable(
	"github_issue_labels",
	{
		systemFrom: text("system_from").notNull(),
		issueNumber: integer("issue_number").notNull(),
		repoNameWithOwner: text("repo_name_with_owner").notNull(),
		labelName: text("label_name").notNull(),
		labelColor: text("label_color").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.systemFrom, table.issueNumber, table.repoNameWithOwner, table.labelName],
		}),
	],
);

export const githubIssuesCache = sqliteTable(
	"github_issues_cache",
	{
		id: integer("id").notNull().default(1),
		data: text("data").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [primaryKey({columns: [table.id, table.systemTo]})],
);

export const githubProjectItems = sqliteTable(
	"github_project_items",
	{
		systemFrom: text("system_from").notNull(),
		itemId: text("item_id").notNull(),
		title: text("title").notNull(),
		status: text("status").notNull(),
		type: text("type", {enum: ["ISSUE", "PULL_REQUEST", "DRAFT_ISSUE"]}).notNull(),
		url: text("url"),
		number: integer("number"),
		repository: text("repository"),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.systemTo, table.itemId]}),
		index("github_project_items_active_idx").on(table.systemTo),
	],
);

export const githubProjectItemLabels = sqliteTable(
	"github_project_item_labels",
	{
		systemFrom: text("system_from").notNull(),
		itemId: text("item_id").notNull(),
		labelName: text("label_name").notNull(),
		labelColor: text("label_color").notNull(),
	},
	(table) => [primaryKey({columns: [table.systemFrom, table.itemId, table.labelName]})],
);

export const githubProjectItemsCache = sqliteTable(
	"github_project_items_cache",
	{
		id: integer("id").notNull().default(1),
		data: text("data").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [primaryKey({columns: [table.id, table.systemTo]})],
);

export const upstreamRefs = sqliteTable(
	"upstream_refs",
	{
		project: text("project").notNull(),
		ref: text("ref").notNull(),
		sha: text("sha").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.systemTo]}),
		index("upstream_refs_active_idx").on(table.project, table.systemTo),
	],
);

export const mergeStatus = sqliteTable(
	"merge_status",
	{
		project: text("project").notNull(),
		sha: text("sha").notNull(),
		upstreamSha: text("upstream_sha").notNull(),
		commitsAhead: integer("commits_ahead").notNull(),
		commitsBehind: integer("commits_behind").notNull(),
		rebaseable: integer("rebaseable", {mode: "boolean"}),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.sha, table.systemTo]}),
		index("merge_status_active_idx").on(table.project, table.systemTo),
	],
);

export const snoozed = sqliteTable(
	"snoozed",
	{
		sha: text("sha").notNull(),
		project: text("project").notNull(),
		shortSha: text("short_sha").notNull().default(""),
		subject: text("subject").notNull().default(""),
		until: text("until"),
		/** Identity across rebases; `sha` is the last-known sha. Null until backfilled, or when the sha is gone. */
		patchId: text("patch_id"),
		/** The sha no longer exists in the repo, so no patch-id could be found. Shown, never auto-deleted. */
		orphaned: integer("orphaned", {mode: "boolean"}).notNull().default(false),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.sha, table.project, table.systemTo]}),
		index("snoozed_active_idx").on(table.systemTo),
		index("snoozed_patch_idx").on(table.patchId, table.project),
	],
);

export const childrenCache = sqliteTable(
	"children_cache",
	{
		project: text("project").notNull(),
		childrenJson: text("children_json").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.systemTo]}),
		index("children_cache_active_idx").on(table.project, table.systemTo),
	],
);

export const todosCache = sqliteTable(
	"todos_cache",
	{
		project: text("project").notNull(),
		todosJson: text("todos_json").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.systemTo]}),
		index("todos_cache_active_idx").on(table.project, table.systemTo),
	],
);

export const cacheFreshness = sqliteTable("cache_freshness", {
	cacheKey: text("cache_key").notNull().primaryKey(),
	lastRefreshed: text("last_refreshed").notNull(),
});

export const advanceConfig = sqliteTable(
	"advance_config",
	{
		project: text("project").notNull(),
		concurrency: integer("concurrency").notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.systemTo]}),
		index("advance_config_active_idx").on(table.project, table.systemTo),
	],
);

export const projectCache = sqliteTable(
	"project_cache",
	{
		name: text("name").notNull(),
		dir: text("dir").notNull(),
		remote: text("remote").notNull(),
		originRemote: text("origin_remote").notNull().default(""),
		upstreamRemote: text("upstream_remote").notNull(),
		upstreamBranch: text("upstream_branch").notNull(),
		upstreamRef: text("upstream_ref").notNull(),
		hasTestConfigured: integer("has_test_configured", {mode: "boolean"}).notNull(),
		dirty: integer("dirty", {mode: "boolean"}).notNull(),
		detachedHead: integer("detached_head", {mode: "boolean"}).notNull(),
		branchCount: integer("branch_count").notNull(),
		rebaseInProgress: integer("rebase_in_progress", {mode: "boolean"}).notNull().default(false),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.name, table.systemTo]}),
		index("project_cache_active_idx").on(table.name, table.systemTo),
	],
);

export const taskRecords = sqliteTable(
	"task_records",
	{
		id: text("id").notNull().primaryKey(),
		kind: text("kind").notNull(),
		project: text("project").notNull(),
		sha: text("sha").notNull(),
		status: text("status", {enum: ["queued", "running", "passed", "failed", "cancelled"]}).notNull(),
		outcome: text("outcome"),
		createdAt: text("created_at").notNull(),
		finishedAt: text("finished_at"),
		error: text("error"),
	},
	(table) => [index("task_records_created_idx").on(table.createdAt)],
);

/** Immutable per-commit facts: patch-id (identity only) and size. A sha's diff never changes, so rows are never updated. */
export const commitFacts = sqliteTable(
	"commit_facts",
	{
		project: text("project").notNull(),
		sha: text("sha").notNull(),
		patchId: text("patch_id").notNull(),
		files: integer("files").notNull(),
		insertions: integer("insertions").notNull(),
		deletions: integer("deletions").notNull(),
	},
	(table) => [primaryKey({columns: [table.project, table.sha]})],
);

/** Per-item priority overrides: a commit keyed by patch-id (survives rebases) or a todo keyed by todoItemKey. */
export const priorityOverrides = sqliteTable(
	"priority_overrides",
	{
		project: text("project").notNull(),
		itemKind: text("item_kind", {enum: ["commit", "todo"]}).notNull(),
		itemKey: text("item_key").notNull(),
		priority: text("priority", {enum: ["high", "medium", "low"]}).notNull(),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.itemKind, table.itemKey, table.systemTo]}),
		index("priority_overrides_active_idx").on(table.project, table.systemTo),
	],
);

/**
 * Work-item ledger (bitemporal): one live row per change (patch-id) per project. Every state
 * change closes the live row and opens a new one, so closed rows are the state history.
 * `first_seen` is carried forward across rebases; `landed` and `abandoned` are terminal.
 */
export const workItems = sqliteTable(
	"work_items",
	{
		project: text("project").notNull(),
		patchId: text("patch_id").notNull(),
		sha: text("sha").notNull(),
		subject: text("subject").notNull(),
		firstSeen: text("first_seen").notNull(),
		state: text("state").notNull(),
		stateSince: text("state_since").notNull(),
		landedAt: text("landed_at"),
		systemFrom: text("system_from").notNull(),
		systemTo: text("system_to").notNull().default(FAR_FUTURE),
	},
	(table) => [
		primaryKey({columns: [table.project, table.patchId, table.systemTo]}),
		index("work_items_active_idx").on(table.project, table.systemTo),
	],
);
