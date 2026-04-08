import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  (table) => ({
    pk: primaryKey({ columns: [table.sha, table.project, table.systemFrom] }),
    activeIdx: index("branch_names_active_idx").on(table.sha, table.project, table.systemTo),
  }),
);

export const testResults = sqliteTable(
  "test_results",
  {
    sha: text("sha").notNull(),
    project: text("project").notNull(),
    testName: text("test_name").notNull().default("default"),
    status: text("status", { enum: ["passed", "failed"] }).notNull(),
    exitCode: integer("exit_code").notNull(),
    durationMs: integer("duration_ms").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sha, table.project, table.testName, table.systemFrom] }),
    activeIdx: index("test_results_active_idx").on(table.project, table.systemTo),
  }),
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
    behind: integer("behind", { mode: "boolean" }).notNull().default(false),
    mergeStateStatus: text("merge_state_status"),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.branch, table.systemFrom] }),
  }),
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
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.branch, table.systemFrom, table.name] }),
  }),
);

export const reportCache = sqliteTable(
  "report_cache",
  {
    id: integer("id").notNull().default(1),
    data: text("data").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.systemFrom] }),
  }),
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
  (table) => ({
    pk: primaryKey({ columns: [table.dir, table.systemFrom, table.key] }),
  }),
);

export const miseEnvCache = sqliteTable(
  "mise_env_cache",
  {
    dir: text("dir").notNull(),
    env: text("env").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.dir, table.systemFrom] }),
  }),
);

export const ghLoginCache = sqliteTable(
  "gh_login_cache",
  {
    id: integer("id").notNull().default(1),
    login: text("login").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.systemFrom] }),
  }),
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
  (table) => ({
    pk: primaryKey({ columns: [table.systemFrom, table.number, table.repoNameWithOwner] }),
  }),
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
  (table) => ({
    pk: primaryKey({
      columns: [table.systemFrom, table.issueNumber, table.repoNameWithOwner, table.labelName],
    }),
  }),
);

export const githubIssuesCache = sqliteTable(
  "github_issues_cache",
  {
    id: integer("id").notNull().default(1),
    data: text("data").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.systemFrom] }),
  }),
);

export const githubProjectItems = sqliteTable(
  "github_project_items",
  {
    systemFrom: text("system_from").notNull(),
    itemId: text("item_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    type: text("type").notNull(),
    url: text("url"),
    number: integer("number"),
    repository: text("repository"),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemFrom, table.itemId] }),
  }),
);

export const githubProjectItemLabels = sqliteTable(
  "github_project_item_labels",
  {
    systemFrom: text("system_from").notNull(),
    itemId: text("item_id").notNull(),
    labelName: text("label_name").notNull(),
    labelColor: text("label_color").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemFrom, table.itemId, table.labelName] }),
  }),
);

export const githubProjectItemsCache = sqliteTable(
  "github_project_items_cache",
  {
    id: integer("id").notNull().default(1),
    data: text("data").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.systemFrom] }),
  }),
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
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.systemFrom] }),
  }),
);

export const mergeStatus = sqliteTable(
  "merge_status",
  {
    project: text("project").notNull(),
    sha: text("sha").notNull(),
    upstreamSha: text("upstream_sha").notNull(),
    commitsAhead: integer("commits_ahead").notNull(),
    commitsBehind: integer("commits_behind").notNull(),
    rebaseable: integer("rebaseable", { mode: "boolean" }),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.sha, table.systemFrom] }),
  }),
);

export const snoozed = sqliteTable(
  "snoozed",
  {
    sha: text("sha").notNull(),
    project: text("project").notNull(),
    shortSha: text("short_sha").notNull().default(""),
    subject: text("subject").notNull().default(""),
    until: text("until"),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sha, table.project, table.systemFrom] }),
  }),
);

export const childrenCache = sqliteTable(
  "children_cache",
  {
    project: text("project").notNull(),
    childrenJson: text("children_json").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.systemFrom] }),
    activeIdx: index("children_cache_active_idx").on(table.project, table.systemTo),
  }),
);

export const todosCache = sqliteTable(
  "todos_cache",
  {
    project: text("project").notNull(),
    todosJson: text("todos_json").notNull(),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.project, table.systemFrom] }),
    activeIdx: index("todos_cache_active_idx").on(table.project, table.systemTo),
  }),
);

export const projectCache = sqliteTable(
  "project_cache",
  {
    name: text("name").notNull(),
    dir: text("dir").notNull(),
    remote: text("remote").notNull(),
    upstreamRemote: text("upstream_remote").notNull(),
    upstreamBranch: text("upstream_branch").notNull(),
    upstreamRef: text("upstream_ref").notNull(),
    hasTestConfigured: integer("has_test_configured", { mode: "boolean" }).notNull(),
    dirty: integer("dirty", { mode: "boolean" }).notNull(),
    detachedHead: integer("detached_head", { mode: "boolean" }).notNull(),
    branchCount: integer("branch_count").notNull(),
    rebaseInProgress: integer("rebase_in_progress", { mode: "boolean" }).notNull().default(false),
    systemFrom: text("system_from").notNull(),
    systemTo: text("system_to").notNull().default(FAR_FUTURE),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.name, table.systemFrom] }),
    activeIdx: index("project_cache_active_idx").on(table.name, table.systemTo),
  }),
);
