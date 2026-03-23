import {index, integer, primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

const FAR_FUTURE = '9999-12-31 23:59:59';

export const branchNames = sqliteTable(
	'branch_names',
	{
		sha: text('sha').notNull(),
		project: text('project').notNull(),
		name: text('name').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
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
		status: text('status').notNull(),
		exitCode: integer('exit_code'),
		durationMs: integer('duration_ms'),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
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
		prNumber: integer('pr_number'),
		failedChecks: text('failed_checks'),
		behind: integer('behind'),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.project, table.branch, table.systemFrom]}),
	}),
);

export const reportCache = sqliteTable(
	'report_cache',
	{
		id: integer('id').notNull().default(1),
		data: text('data').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.id, table.systemFrom]}),
	}),
);

export const miseEnvCache = sqliteTable(
	'mise_env_cache',
	{
		dir: text('dir').notNull(),
		env: text('env').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.dir, table.systemFrom]}),
	}),
);

export const ghLoginCache = sqliteTable(
	'gh_login_cache',
	{
		id: integer('id').notNull().default(1),
		login: text('login').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.id, table.systemFrom]}),
	}),
);

export const githubIssuesCache = sqliteTable(
	'github_issues_cache',
	{
		id: integer('id').notNull().default(1),
		data: text('data').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.id, table.systemFrom]}),
	}),
);

export const githubProjectItemsCache = sqliteTable(
	'github_project_items_cache',
	{
		id: integer('id').notNull().default(1),
		data: text('data').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.id, table.systemFrom]}),
	}),
);

export const upstreamRefs = sqliteTable(
	'upstream_refs',
	{
		project: text('project').notNull(),
		ref: text('ref').notNull(),
		sha: text('sha').notNull(),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.project, table.systemFrom]}),
	}),
);

export const mergeStatus = sqliteTable(
	'merge_status',
	{
		project: text('project').notNull(),
		sha: text('sha').notNull(),
		upstreamSha: text('upstream_sha').notNull(),
		commitsAhead: integer('commits_ahead').notNull(),
		commitsBehind: integer('commits_behind').notNull(),
		rebaseable: integer('rebaseable'),
		systemFrom: text('system_from').notNull(),
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.project, table.sha, table.systemFrom]}),
	}),
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
		systemTo: text('system_to').notNull().default(FAR_FUTURE),
	},
	(table) => ({
		pk: primaryKey({columns: [table.sha, table.project, table.systemFrom]}),
	}),
);
