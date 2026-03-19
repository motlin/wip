import {primaryKey, sqliteTable, text} from 'drizzle-orm/sqlite-core';

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
