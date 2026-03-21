import {index, integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

export const branchNames = sqliteTable(
	'branch_names',
	{
		sha: text('sha').notNull(),
		project: text('project').notNull(),
		name: text('name').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default('9999-12-31 23:59:59'),
	},
	(table) => ({
		pk: primaryKey({columns: [table.sha, table.project, table.systemFrom]}),
		activeIdx: index('branch_names_active_idx').on(table.sha, table.project, table.systemTo),
	}),
);

export const testResults = sqliteTable(
	'test_results',
	{
		sha: text('sha').notNull(),
		project: text('project').notNull(),
		testName: text('test_name').notNull().default('default'),
		status: text('status').notNull(), // 'passed' | 'failed'
		exitCode: integer('exit_code'),
		durationMs: integer('duration_ms'),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default('9999-12-31 23:59:59'),
	},
	(table) => ({
		pk: primaryKey({columns: [table.sha, table.project, table.testName, table.systemFrom]}),
		activeIdx: index('test_results_active_idx').on(table.project, table.systemTo),
	}),
);

export const prStatusCache = sqliteTable(
	'pr_status_cache',
	{
		project: text('project').notNull(),
		branch: text('branch').notNull(),
		reviewStatus: text('review_status').notNull(),
		checkStatus: text('check_status').notNull(),
		prUrl: text('pr_url'),
		failedChecks: text('failed_checks'),
		behind: integer('behind'),
		cachedAt: text('cached_at').notNull(),
	},
	(table) => ({
		pk: primaryKey({columns: [table.project, table.branch]}),
	}),
);

export const reportCache = sqliteTable(
	'report_cache',
	{
		id: integer('id').notNull().default(1).primaryKey(),
		data: text('data').notNull(),
		cachedAt: text('cached_at').notNull(),
	},
);

export const miseEnvCache = sqliteTable(
	'mise_env_cache',
	{
		dir: text('dir').notNull().primaryKey(),
		env: text('env').notNull(),
		cachedAt: text('cached_at').notNull(),
	},
);

export const ghLoginCache = sqliteTable(
	'gh_login_cache',
	{
		id: integer('id').notNull().default(1).primaryKey(),
		login: text('login').notNull(),
		cachedAt: text('cached_at').notNull(),
	},
);

export const githubIssuesCache = sqliteTable(
	'github_issues_cache',
	{
		id: integer('id').notNull().default(1).primaryKey(),
		data: text('data').notNull(),
		cachedAt: text('cached_at').notNull(),
	},
);

export const githubProjectItemsCache = sqliteTable(
	'github_project_items_cache',
	{
		id: integer('id').notNull().default(1).primaryKey(),
		data: text('data').notNull(),
		cachedAt: text('cached_at').notNull(),
	},
);

export const snoozed = sqliteTable(
	'snoozed',
	{
		sha: text('sha').notNull(),
		project: text('project').notNull(),
		shortSha: text('short_sha').notNull().default(''),
		subject: text('subject').notNull().default(''),
		until: text('until'),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default('9999-12-31 23:59:59'),
	},
	(table) => ({
		pk: primaryKey({columns: [table.sha, table.project, table.systemFrom]}),
	}),
);
