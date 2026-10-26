import {Args, Command, Flags} from "@oclif/core";
import chalk from "chalk";
import {execa} from "execa";

import {type Category, discoverAllProjects, getChildCommits, getPrStatuses, getProjectsDirs} from "@wip/shared";
import {classifyGitChild} from "@wip/shared/classify.js";

interface ClassifiedChild {
	project: string;
	sha: string;
	shortSha: string;
	subject: string;
	date: string;
	category: Category;
}

interface ReportJson {
	summary: {
		projects: number;
		children: number;
		snoozed: number;
		skippable: number;
		untriaged: number;
		triaged: number;
		noTest: number;
		detachedHead: number;
		localChanges: number;
		readyToTest: number;
		testRunning: number;
		testFailed: number;
		needsRebase: number;
		rebaseUnknown: number;
		rebaseConflicts: number;
		rebaseStuck: number;
		readyToPush: number;
		pushedNoPr: number;
		checksUnknown: number;
		checksRunning: number;
		checksFailed: number;
		checksPassed: number;
		reviewComments: number;
		changesRequested: number;
		approved: number;
	};
	snoozed: ClassifiedChild[];
	skippable: ClassifiedChild[];
	untriaged: ClassifiedChild[];
	triaged: ClassifiedChild[];
	noTest: ClassifiedChild[];
	detachedHead: ClassifiedChild[];
	localChanges: ClassifiedChild[];
	readyToTest: ClassifiedChild[];
	testRunning: ClassifiedChild[];
	testFailed: ClassifiedChild[];
	needsRebase: ClassifiedChild[];
	rebaseUnknown: ClassifiedChild[];
	rebaseConflicts: ClassifiedChild[];
	rebaseStuck: ClassifiedChild[];
	readyToPush: ClassifiedChild[];
	pushedNoPr: ClassifiedChild[];
	checksUnknown: ClassifiedChild[];
	checksRunning: ClassifiedChild[];
	checksFailed: ClassifiedChild[];
	checksPassed: ClassifiedChild[];
	reviewComments: ClassifiedChild[];
	changesRequested: ClassifiedChild[];
	approved: ClassifiedChild[];
	nextSteps: string[];
}

// Kanban left-to-right: full SDLC flow
const CATEGORY_ORDER: Category[] = [
	"snoozed",
	"skippable",
	"untriaged",
	"triaged",
	"no_test",
	"detached_head",
	"local_changes",
	"ready_to_test",
	"test_running",
	"test_failed",
	"needs_rebase",
	"rebase_unknown",
	"rebase_conflicts",
	"rebase_stuck",
	"ready_to_push",
	"pushing",
	"pushed_no_pr",
	"checks_unknown",
	"checks_running",
	"checks_failed",
	"checks_passed",
	"review_comments",
	"changes_requested",
	"approved",
];

const CATEGORY_LABELS: Record<Category, string> = {
	snoozed: "Snoozed",
	skippable: "Skippable",
	untriaged: "Untriaged",
	triaged: "Triaged",
	blocked: "Blocked",
	no_test: "No test configured",
	detached_head: "Detached HEAD",
	local_changes: "Local changes — dirty worktree",
	ready_to_test: "Ready to test",
	test_running: "Test running",
	test_failed: "Test failed",
	needs_rebase: "Needs rebase",
	rebase_unknown: "Rebase unknown",
	rebase_conflicts: "Rebase conflicts",
	rebase_stuck: "Rebase stuck",
	ready_to_push: "Ready to push",
	pushing: "Pushing",
	pushed_no_pr: "Needs PR",
	checks_unknown: "Checks unknown",
	checks_running: "Checks running",
	checks_failed: "Checks failed",
	checks_passed: "Checks passed",
	review_comments: "Review comments",
	changes_requested: "Changes requested",
	approved: "Approved",
	landed: "Landed",
};

function categoryStyle(category: Category, text: string): string {
	switch (category) {
		case "landed":
		case "approved":
		case "checks_passed":
			return chalk.green(text);
		case "ready_to_push":
			return chalk.cyan(text);
		case "changes_requested":
			return chalk.magenta(text);
		case "review_comments":
		case "pushed_no_pr":
			return chalk.blue(text);
		case "test_failed":
		case "checks_failed":
		case "rebase_conflicts":
		case "rebase_stuck":
		case "blocked":
			return chalk.red(text);
		case "ready_to_test":
		case "test_running":
		case "checks_running":
		case "detached_head":
		case "needs_rebase":
		case "rebase_unknown":
		case "pushing":
			return chalk.yellow(text);
		case "local_changes":
		case "no_test":
		case "skippable":
		case "snoozed":
			return chalk.yellow(text);
		case "untriaged":
		case "triaged":
		case "checks_unknown":
			return chalk.dim(text);
		default: {
			const unreachable: never = category;
			return unreachable;
		}
	}
}

export default class Report extends Command {
	static override args = {
		project: Args.string({description: "Filter to a specific project name"}),
	};

	static override description = "Show a holistic WIP report grouped by action needed";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> report",
		"<%= config.bin %> report liftwizard",
		"<%= config.bin %> report --summary",
		"<%= config.bin %> report --json",
		"<%= config.bin %> report --quiet",
	];

	static override flags = {
		"projects-dir": Flags.string({description: "Override projects directory"}),
		quiet: Flags.boolean({
			char: "q",
			default: false,
			description: "SHAs only, grouped by category",
		}),
		summary: Flags.boolean({
			char: "s",
			default: false,
			description: "Counts only, no individual commits",
		}),
	};

	async run(): Promise<ReportJson> {
		const {args, flags} = await this.parse(Report);
		const projectsDirs = getProjectsDirs(flags["projects-dir"]);
		const projects = await discoverAllProjects(projectsDirs);

		const grouped: Record<Category, ClassifiedChild[]> = {
			snoozed: [],
			skippable: [],
			untriaged: [],
			triaged: [],
			blocked: [],
			no_test: [],
			detached_head: [],
			local_changes: [],
			ready_to_test: [],
			test_running: [],
			test_failed: [],
			needs_rebase: [],
			rebase_unknown: [],
			rebase_conflicts: [],
			rebase_stuck: [],
			ready_to_push: [],
			pushing: [],
			pushed_no_pr: [],
			checks_unknown: [],
			checks_running: [],
			checks_failed: [],
			checks_passed: [],
			review_comments: [],
			changes_requested: [],
			approved: [],
			landed: [],
		};

		let projectCount = 0;
		const dirtyProjects = new Set<string>();

		/* oxlint-disable no-await-in-loop -- projects are fetched sequentially to bound gh/git subprocess load */
		for (const p of projects) {
			if (args.project && p.name !== args.project) continue;

			const prStatuses = await getPrStatuses(p.dir, p.name, p.upstreamRemote);
			const children = await getChildCommits(p.dir, p.upstreamRef, p.hasTestConfigured, prStatuses);
			if (children.length === 0 && !args.project) continue;

			projectCount++;
			if (p.dirty) dirtyProjects.add(p.name);

			const headSha = (await execa("git", ["-C", p.dir, "rev-parse", "HEAD"], {reject: false})).stdout.trim();
			for (const child of children) {
				const category = classifyGitChild(
					{
						...child,
						project: p.name,
						remote: p.remote,
						originRemote: p.originRemote,
						isHead: child.sha === headSha,
					},
					p,
				);
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
		/* oxlint-enable no-await-in-loop */

		const totalChildren = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
		const nextSteps = this.buildNextSteps(grouped, dirtyProjects);

		const output: ReportJson = {
			summary: {
				projects: projectCount,
				children: totalChildren,
				snoozed: grouped.snoozed.length,
				skippable: grouped.skippable.length,
				untriaged: grouped.untriaged.length,
				triaged: grouped.triaged.length,
				noTest: grouped.no_test.length,
				detachedHead: grouped.detached_head.length,
				localChanges: grouped.local_changes.length,
				readyToTest: grouped.ready_to_test.length,
				testRunning: grouped.test_running.length,
				testFailed: grouped.test_failed.length,
				needsRebase: grouped.needs_rebase.length,
				rebaseUnknown: grouped.rebase_unknown.length,
				rebaseConflicts: grouped.rebase_conflicts.length,
				rebaseStuck: grouped.rebase_stuck.length,
				readyToPush: grouped.ready_to_push.length,
				pushedNoPr: grouped.pushed_no_pr.length,
				checksUnknown: grouped.checks_unknown.length,
				checksRunning: grouped.checks_running.length,
				checksFailed: grouped.checks_failed.length,
				checksPassed: grouped.checks_passed.length,
				reviewComments: grouped.review_comments.length,
				changesRequested: grouped.changes_requested.length,
				approved: grouped.approved.length,
			},
			snoozed: grouped.snoozed,
			skippable: grouped.skippable,
			untriaged: grouped.untriaged,
			triaged: grouped.triaged,
			noTest: grouped.no_test,
			detachedHead: grouped.detached_head,
			localChanges: grouped.local_changes,
			readyToTest: grouped.ready_to_test,
			testRunning: grouped.test_running,
			testFailed: grouped.test_failed,
			needsRebase: grouped.needs_rebase,
			rebaseUnknown: grouped.rebase_unknown,
			rebaseConflicts: grouped.rebase_conflicts,
			rebaseStuck: grouped.rebase_stuck,
			readyToPush: grouped.ready_to_push,
			pushedNoPr: grouped.pushed_no_pr,
			checksUnknown: grouped.checks_unknown,
			checksRunning: grouped.checks_running,
			checksFailed: grouped.checks_failed,
			checksPassed: grouped.checks_passed,
			reviewComments: grouped.review_comments,
			changesRequested: grouped.changes_requested,
			approved: grouped.approved,
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

			this.log("");
		}

		if (nextSteps.length > 0) {
			this.log("Next steps:");
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

		if (grouped.checks_passed.length > 0) {
			steps.push(
				`gh pr view                  # merge ${grouped.checks_passed.length} passed checks (waiting on review)`,
			);
		}

		if (grouped.ready_to_push.length > 0) {
			steps.push(`wip push                    # push ${grouped.ready_to_push.length} green children`);
		}

		if (grouped.pushed_no_pr.length > 0) {
			steps.push(`gh pr create                # create ${grouped.pushed_no_pr.length} PRs`);
		}

		if (grouped.changes_requested.length > 0) {
			steps.push(
				`gh pr view                  # address ${grouped.changes_requested.length} PRs with changes requested`,
			);
		}

		if (grouped.review_comments.length > 0) {
			steps.push(
				`gh pr view                  # respond to ${grouped.review_comments.length} PRs with review comments`,
			);
		}

		if (grouped.rebase_conflicts.length > 0) {
			steps.push(
				`# ${grouped.rebase_conflicts.length} branches have rebase conflicts — manual resolution needed`,
			);
		}

		if (grouped.needs_rebase.length > 0) {
			steps.push(`git rebase upstream/main    # rebase ${grouped.needs_rebase.length} branches`);
		}

		if (grouped.detached_head.length > 0) {
			steps.push(
				`wip branch                  # create branches for ${grouped.detached_head.length} detached HEADs`,
			);
		}

		if (grouped.checks_failed.length > 0) {
			steps.push(`wip results --status failed # investigate ${grouped.checks_failed.length} PR check failures`);
		}

		if (grouped.test_failed.length > 0) {
			steps.push(`wip results --status failed # investigate ${grouped.test_failed.length} local test failures`);
		}

		if (grouped.ready_to_test.length > 0) {
			steps.push(`wip test                    # test ${grouped.ready_to_test.length} untested children`);
		}

		if (grouped.checks_running.length > 0) {
			steps.push(`# Waiting for ${grouped.checks_running.length} check runs to complete...`);
		}

		if (grouped.checks_unknown.length > 0) {
			steps.push(`# ${grouped.checks_unknown.length} check statuses unknown, may need refresh`);
		}

		if (dirtyProjects.size > 0) {
			const first = [...dirtyProjects][0];
			steps.push(`cd ~/projects/${first}  # clean worktree, unblock ${grouped.local_changes.length}`);
		}

		if (grouped.snoozed.length > 0) {
			steps.push(`# ${grouped.snoozed.length} snoozed items`);
		}

		if (grouped.untriaged.length > 0) {
			steps.push(`# ${grouped.untriaged.length} untriaged`);
		}

		if (grouped.triaged.length > 0) {
			steps.push(`# ${grouped.triaged.length} triaged`);
		}

		return steps;
	}
}
