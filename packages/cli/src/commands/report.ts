import {Args, Command, Flags} from '@oclif/core';
import chalk from 'chalk';

import {type ChildCommit, type ProjectInfo, discoverAllProjects, getChildCommits, getPrStatuses, getProjectsDirs} from '@wip/shared';

type Category = 'approved' | 'ready_to_push' | 'changes_requested' | 'review_comments' | 'test_failed' | 'ready_to_test' | 'local_changes' | 'no_test' | 'skippable';

interface ClassifiedChild {
	project: string;
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	category: Category;
}

interface ReportJson {
	summary: {projects: number; children: number; approved: number; readyToPush: number; changesRequested: number; reviewComments: number; testFailed: number; readyToTest: number; localChanges: number; noTest: number; skippable: number};
	approved: ClassifiedChild[];
	readyToPush: ClassifiedChild[];
	changesRequested: ClassifiedChild[];
	reviewComments: ClassifiedChild[];
	testFailed: ClassifiedChild[];
	readyToTest: ClassifiedChild[];
	localChanges: ClassifiedChild[];
	noTest: ClassifiedChild[];
	skippable: ClassifiedChild[];
	nextSteps: string[];
}

function classifyChild(child: ChildCommit, project: ProjectInfo): Category {
	if (child.skippable) return 'skippable';
	if (child.testStatus === 'passed') {
		if (child.reviewStatus === 'approved') return 'approved';
		if (child.reviewStatus === 'changes_requested') return 'changes_requested';
		if (child.reviewStatus === 'commented') return 'review_comments';
		return 'ready_to_push';
	}
	if (child.testStatus === 'failed') return 'test_failed';
	if (project.dirty) return 'local_changes';
	if (!project.hasTestConfigured) return 'no_test';
	return 'ready_to_test';
}

const CATEGORY_ORDER: Category[] = ['approved', 'ready_to_push', 'changes_requested', 'review_comments', 'test_failed', 'ready_to_test', 'local_changes', 'no_test', 'skippable'];

const CATEGORY_LABELS: Record<Category, string> = {
	approved: 'Approved',
	ready_to_push: 'Ready to push',
	changes_requested: 'Changes requested',
	review_comments: 'Review comments',
	test_failed: 'Test failed',
	ready_to_test: 'Ready to test',
	local_changes: 'Local changes — dirty worktree',
	no_test: 'No test configured',
	skippable: 'Skippable',
};

function categoryStyle(category: Category, text: string): string {
	switch (category) {
		case 'approved':
			return chalk.green(text);
		case 'ready_to_push':
			return chalk.green(text);
		case 'changes_requested':
			return chalk.magenta(text);
		case 'review_comments':
			return chalk.cyan(text);
		case 'test_failed':
			return chalk.red(text);
		case 'ready_to_test':
			return chalk.yellow(text);
		case 'local_changes':
		case 'no_test':
		case 'skippable':
			return chalk.dim(text);
	}
}

export default class Report extends Command {
	static override args = {
		project: Args.string({description: 'Filter to a specific project name'}),
	};

	static override description = 'Show a holistic WIP report grouped by action needed';

	static enableJsonFlag = true;

	static override examples = [
		'<%= config.bin %> report',
		'<%= config.bin %> report liftwizard',
		'<%= config.bin %> report --summary',
		'<%= config.bin %> report --json',
		'<%= config.bin %> report --quiet',
	];

	static override flags = {
		'projects-dir': Flags.string({description: 'Override projects directory'}),
		quiet: Flags.boolean({char: 'q', default: false, description: 'SHAs only, grouped by category'}),
		summary: Flags.boolean({char: 's', default: false, description: 'Counts only, no individual commits'}),
	};

	async run(): Promise<ReportJson> {
		const {args, flags} = await this.parse(Report);
		const projectsDirs = getProjectsDirs(flags['projects-dir']);
		const projects = await discoverAllProjects(projectsDirs);

		const grouped: Record<Category, ClassifiedChild[]> = {
			approved: [],
			ready_to_push: [],
			changes_requested: [],
			review_comments: [],
			test_failed: [],
			ready_to_test: [],
			local_changes: [],
			no_test: [],
			skippable: [],
		};

		let projectCount = 0;
		const dirtyProjects = new Set<string>();

		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const prStatuses = await getPrStatuses(p.dir, p.name);
			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses, p.name);
			if (children.length === 0 && !args.project) continue;

			projectCount++;

			for (const child of children) {
				const category = classifyChild(child, p);
				if (category === 'local_changes') dirtyProjects.add(p.name);
				grouped[category].push({
					project: p.name,
					sha: child.sha,
					shortSha: child.shortSha,
					subject: child.subject,
					date: child.date,
					category,
				});
			}
		}

		const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
		const nextSteps = this.buildNextSteps(grouped, dirtyProjects);

		const output: ReportJson = {
			summary: {
				projects: projectCount,
				children: totalChildren,
				approved: grouped.approved.length,
				readyToPush: grouped.ready_to_push.length,
				changesRequested: grouped.changes_requested.length,
				reviewComments: grouped.review_comments.length,
				testFailed: grouped.test_failed.length,
				readyToTest: grouped.ready_to_test.length,
				localChanges: grouped.local_changes.length,
				noTest: grouped.no_test.length,
				skippable: grouped.skippable.length,
			},
			approved: grouped.approved,
			readyToPush: grouped.ready_to_push,
			changesRequested: grouped.changes_requested,
			reviewComments: grouped.review_comments,
			testFailed: grouped.test_failed,
			readyToTest: grouped.ready_to_test,
			localChanges: grouped.local_changes,
			noTest: grouped.no_test,
			skippable: grouped.skippable,
			nextSteps,
		};

		if (flags.quiet) {
			for (const category of CATEGORY_ORDER) {
				const items = grouped[category];
				if (items.length === 0) continue;
				this.log(`# ${category}`);
				for (const item of items) {
					this.log(item.sha);
				}
			}
			return output;
		}

		this.log(`WIP Report — ${projectCount} projects, ${totalChildren} children\n`);

		for (const category of CATEGORY_ORDER) {
			const items = grouped[category];
			if (items.length === 0) continue;

			const label = CATEGORY_LABELS[category];
			this.log(categoryStyle(category, `${label} (${items.length})`));

			if (!flags.summary) {
				for (const item of items) {
					this.log(`  ${item.project.padEnd(20)} ${item.shortSha}  ${item.subject}`);
				}
			}

			this.log('');
		}

		if (nextSteps.length > 0) {
			this.log('Next steps:');
			for (const step of nextSteps) {
				this.log(`  ${step}`);
			}
		}

		return output;
	}

	private buildNextSteps(grouped: Record<Category, ClassifiedChild[]>, dirtyProjects: Set<string>): string[] {
		const steps: string[] = [];

		if (grouped.approved.length > 0) {
			steps.push(`gh pr merge                 # merge ${grouped.approved.length} approved PRs`);
		}

		if (grouped.ready_to_push.length > 0) {
			steps.push(`wip push                    # push ${grouped.ready_to_push.length} green children`);
		}

		if (grouped.changes_requested.length > 0) {
			steps.push(`gh pr view                  # address ${grouped.changes_requested.length} PRs with changes requested`);
		}

		if (grouped.review_comments.length > 0) {
			steps.push(`gh pr view                  # respond to ${grouped.review_comments.length} PRs with review comments`);
		}

		if (grouped.test_failed.length > 0) {
			steps.push(`wip results --status failed # investigate ${grouped.test_failed.length} failures`);
		}

		if (grouped.ready_to_test.length > 0) {
			steps.push(`wip test                    # test ${grouped.ready_to_test.length} untested children`);
		}

		if (dirtyProjects.size > 0) {
			const first = [...dirtyProjects][0];
			steps.push(`cd ~/projects/${first}  # clean worktree, unblock ${grouped.local_changes.length}`);
		}

		return steps;
	}
}
