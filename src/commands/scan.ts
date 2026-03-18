import {Command, Flags} from '@oclif/core';
import chalk from 'chalk';

import {getProjectsDir} from '../lib/config.js';
import {type ProjectInfo, discoverProjects, getChildren} from '../lib/git.js';

interface ProjectRow {
	name: string;
	remote: string;
	upstream: string;
	dirty: boolean;
	branches: number;
	children: number;
	hasTest: boolean;
}

export default class Scan extends Command {
	static override description = 'Scan all projects for WIP status';

	static override examples = ['<%= config.bin %> scan'];

	static override flags = {
		'projects-dir': Flags.string({description: 'Override projects directory'}),
	};

	async run(): Promise<void> {
		const {flags} = await this.parse(Scan);
		const projectsDir = getProjectsDir(flags['projects-dir']);
		const projects = await discoverProjects(projectsDir);

		const rows: ProjectRow[] = await Promise.all(
			projects.map(async (p: ProjectInfo) => {
				const children = await getChildren(p.dir, p.upstreamRef);
				return {
					name: p.name,
					remote: p.remote,
					upstream: p.upstreamRef,
					dirty: p.dirty,
					branches: p.branchCount,
					children: children.length,
					hasTest: p.hasTestConfigured,
				};
			}),
		);

		rows.sort((a, b) => {
			if (b.children !== a.children) return b.children - a.children;
			if (b.branches !== a.branches) return b.branches - a.branches;
			return a.name.localeCompare(b.name);
		});

		const dirtyCount = rows.filter((r) => r.dirty).length;
		const childCount = rows.reduce((sum, r) => sum + r.children, 0);
		const branchCount = rows.reduce((sum, r) => sum + r.branches, 0);
		const testCount = rows.filter((r) => r.hasTest).length;

		this.log(`Found ${rows.length} projects (${dirtyCount} dirty, ${childCount} children, ${branchCount} branches, ${testCount} with tests)\n`);

		const nameW = Math.max(4, ...rows.map((r) => r.name.length));
		const header = `${'Name'.padEnd(nameW)}  Dirty  Branches  Children  Test`;
		this.log(header);
		this.log('-'.repeat(header.length));

		for (const row of rows) {
			if (row.branches === 0 && row.children === 0 && !row.dirty) continue;

			const dirty = row.dirty ? chalk.red('yes') : '   ';
			const branches = row.branches > 0 ? String(row.branches).padStart(4) : '   0';
			const children = row.children > 0 ? chalk.yellow(String(row.children).padStart(4)) : '   0';
			const test = row.hasTest ? chalk.green('yes') : chalk.dim('no');

			this.log(`${row.name.padEnd(nameW)}  ${dirty.padEnd(dirty.length > 3 ? 5 + (dirty.length - 3) : 5)}  ${branches.padStart(8)}  ${children.padStart(children.length > 4 ? 8 + (children.length - 4) : 8)}  ${test}`);
		}
	}
}
