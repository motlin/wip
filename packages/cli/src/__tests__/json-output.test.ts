import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

import type {ChildCommit, ProjectInfo} from '@wip/shared';

// Mock @wip/shared before importing commands
vi.mock('@wip/shared', () => ({
	getProjectsDir: vi.fn((flag?: string) => flag ?? '/tmp/fake-projects'),
	discoverProjects: vi.fn(),
	getChildCommits: vi.fn(),
	getChildren: vi.fn(),
	getPrStatuses: vi.fn(async () => ({review: new Map(), checks: new Map()})),
	isDirty: vi.fn(),
	readConfig: vi.fn(),
	getConfigValue: vi.fn(),
	setConfigValue: vi.fn(),
	unsetConfigValue: vi.fn(),
	getTestLogDir: vi.fn(() => '/tmp/fake-test-logs'),
	getMiseEnv: vi.fn(async () => ({})),
	createBranchForChild: vi.fn(async (_dir: string, child: {branch?: string; subject: string}) => child.branch ?? child.subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')),
	testBranch: vi.fn(async () => ({exitCode: 0, logContent: ''})),
	testFix: vi.fn(async () => ({ok: true, message: 'fixed'})),
	hasLocalModifications: vi.fn(async () => false),
	subjectToSlug: vi.fn((s: string) => s.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')),
	getDb: vi.fn(),
	snoozeItem: vi.fn(),
	unsnoozeItem: vi.fn(),
	getActiveSnoozed: vi.fn(() => []),
	getSnoozedSet: vi.fn(() => new Set()),
	getAllSnoozed: vi.fn(() => []),
	clearExpiredSnoozes: vi.fn(() => 0),
	log: {subprocess: {debug: vi.fn()}},
}));

// Mock execa to prevent real process execution
vi.mock('execa', () => ({
	execa: vi.fn(async () => ({exitCode: 0, stdout: '', stderr: ''})),
}));

// Mock fs for test command
vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	return {
		...actual,
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
	};
});

import {discoverProjects, getChildCommits, getChildren, isDirty, readConfig, getConfigValue} from '@wip/shared';

const fakeProject: ProjectInfo = {
	name: 'test-project',
	dir: '/tmp/fake-projects/test-project',
	remote: 'user/test-project',
	upstreamRemote: 'origin',
	upstreamBranch: 'main',
	upstreamRef: 'origin/main',
	dirty: false,
	branchCount: 1,
	hasTestConfigured: true,
};

const fakeChild: ChildCommit = {
	sha: 'abc123def456789012345678901234567890abcd',
	shortSha: 'abc123d',
	subject: 'Add feature X',
	date: '2025-01-15',
	branch: 'feature-x',
	testStatus: 'passed',
	checkStatus: 'none',
	skippable: false,
	pushedToRemote: false,
	reviewStatus: 'no_pr',
};

const fakeChildFailed: ChildCommit = {
	sha: 'def456789012345678901234567890abcdef1234',
	shortSha: 'def4567',
	subject: 'Fix bug Y',
	date: '2025-01-16',
	branch: undefined,
	testStatus: 'failed',
	checkStatus: 'none',
	skippable: false,
	pushedToRemote: false,
	reviewStatus: 'no_pr',
};

/**
 * Capture all console.log output during command execution.
 * oclif's ux.stdout uses console.log internally.
 */
function captureConsoleLog(): {getOutput: () => string; restore: () => void} {
	const lines: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	return {
		getOutput: () => lines.join('\n'),
		restore: () => {
			console.log = originalLog;
		},
	};
}

/**
 * Assert that captured output is valid JSON with no extra non-JSON content.
 * The output may contain ANSI color codes from oclif's colorizeJson, so we strip those.
 */
function assertValidJsonOutput(output: string): unknown {
	expect(output.trim()).not.toBe('');
	// Strip ANSI escape codes that oclif's colorizeJson may add
	const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
	const parsed = JSON.parse(stripped);
	expect(parsed).toBeDefined();
	return parsed;
}

describe('JSON output mode', () => {
	let capture: ReturnType<typeof captureConsoleLog>;

	beforeEach(() => {
		vi.mocked(discoverProjects).mockResolvedValue([fakeProject]);
		vi.mocked(getChildCommits).mockResolvedValue([fakeChild, fakeChildFailed]);
		vi.mocked(getChildren).mockResolvedValue([fakeChild.sha, fakeChildFailed.sha]);
		vi.mocked(isDirty).mockResolvedValue(false);
		vi.mocked(readConfig).mockReturnValue({projectsDir: '/tmp/fake-projects'});
		vi.mocked(getConfigValue).mockReturnValue('/tmp/fake-projects');
		capture = captureConsoleLog();
	});

	afterEach(() => {
		capture.restore();
		vi.clearAllMocks();
	});

	describe('children --json', () => {
		it('outputs only valid JSON to stdout', async () => {
			const {default: Children} = await import('../commands/children.js');
			await Children.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('projects');
			expect(parsed).toHaveProperty('summary');
			expect((parsed as any).summary).toEqual({total: 2, passed: 1, failed: 1, unknown: 0});
			expect((parsed as any).projects).toHaveLength(1);
			expect((parsed as any).projects[0].name).toBe('test-project');
		});

		it('returns structured data from run()', async () => {
			const {default: Children} = await import('../commands/children.js');
			const result = await Children.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			expect(result).toHaveProperty('projects');
			expect(result).toHaveProperty('summary');
			expect(result.summary.total).toBe(2);
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Children} = await import('../commands/children.js');
			await Children.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			// Strip ANSI codes
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			// Should not contain human-readable table fragments
			expect(stripped).not.toContain('\u2713');
			expect(stripped).not.toContain('\u2717');
			expect(stripped).not.toContain('Total:');
		});
	});

	describe('results --json', () => {
		it('outputs only valid JSON to stdout', async () => {
			const {default: Results} = await import('../commands/results.js');
			await Results.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('results');
			expect(parsed).toHaveProperty('summary');
			expect((parsed as any).results).toHaveLength(2);
			expect((parsed as any).summary).toEqual({total: 2, passed: 1, failed: 1, unknown: 0});
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Results} = await import('../commands/results.js');
			await Results.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			// Should not have the human summary line format
			expect(stripped).not.toMatch(/\d+ results:/);
		});
	});

	describe('report --json', () => {
		it('outputs only valid JSON to stdout', async () => {
			const {default: Report} = await import('../commands/report.js');
			await Report.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('summary');
			expect(parsed).toHaveProperty('readyToPush');
			expect(parsed).toHaveProperty('testFailed');
			expect(parsed).toHaveProperty('nextSteps');
			expect((parsed as any).summary.children).toBe(2);
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Report} = await import('../commands/report.js');
			await Report.run(['--json', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('WIP Report');
			expect(stripped).not.toContain('Next steps:');
		});
	});

	describe('push --json', () => {
		it('outputs only valid JSON to stdout', async () => {
			const {default: Push} = await import('../commands/push.js');
			await Push.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('pushed');
			expect(parsed).toHaveProperty('skippedProjects');
			expect(parsed).toHaveProperty('summary');
		});

		it('includes dryRun flag in JSON output', async () => {
			const {default: Push} = await import('../commands/push.js');
			const result = await Push.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			expect(result).toHaveProperty('dryRun', true);
		});

		it('uses planned status in dry-run mode', async () => {
			const {default: Push} = await import('../commands/push.js');
			const result = await Push.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			for (const item of (result as any).pushed) {
				expect(item.status).toBe('planned');
			}
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Push} = await import('../commands/push.js');
			await Push.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('would push');
			expect(stripped).not.toContain('Pushed');
			expect(stripped).not.toContain('Skipping');
		});
	});

	describe('test --json', () => {
		it('outputs only valid JSON to stdout with --dry-run', async () => {
			const {default: Test} = await import('../commands/test.js');
			await Test.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('results');
			expect(parsed).toHaveProperty('skippedProjects');
			expect(parsed).toHaveProperty('summary');
		});

		it('includes dryRun flag in JSON output', async () => {
			const {default: Test} = await import('../commands/test.js');
			const result = await Test.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			expect(result).toHaveProperty('dryRun', true);
		});

		it('uses planned status in dry-run mode', async () => {
			const {default: Test} = await import('../commands/test.js');
			const result = await Test.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			for (const item of (result as any).results) {
				expect(item.status).toBe('planned');
			}
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Test} = await import('../commands/test.js');
			await Test.run(['--json', '--dry-run', '--projects-dir', '/tmp/fake-projects']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('would test');
			expect(stripped).not.toContain('Testing');
			expect(stripped).not.toContain('Tested');
		});

		it('includes dryRun flag in fast mode JSON output', async () => {
			const {default: Test} = await import('../commands/test.js');
			const result = await Test.run(['--json', '--dry-run', '--fast', '--projects-dir', '/tmp/fake-projects']);

			expect(result).toHaveProperty('dryRun', true);
		});

		it('uses planned status in fast dry-run mode', async () => {
			const {default: Test} = await import('../commands/test.js');
			const result = await Test.run(['--json', '--dry-run', '--fast', '--projects-dir', '/tmp/fake-projects']);

			for (const item of (result as any).results) {
				expect(item.status).toBe('planned');
			}
		});
	});

	describe('config set --json --dry-run', () => {
		it('outputs valid JSON showing what would be set', async () => {
			const {default: ConfigSet} = await import('../commands/config/set.js');
			await ConfigSet.run(['myKey', 'myValue', '--dry-run', '--json']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('key', 'myKey');
			expect(parsed).toHaveProperty('value', 'myValue');
			expect(parsed).toHaveProperty('dryRun', true);
		});

		it('does not mutate config in dry-run mode', async () => {
			const {setConfigValue} = await import('@wip/shared');
			vi.mocked(setConfigValue).mockClear();

			const {default: ConfigSet} = await import('../commands/config/set.js');
			await ConfigSet.run(['myKey', 'myValue', '--dry-run']);

			expect(setConfigValue).not.toHaveBeenCalled();
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: ConfigSet} = await import('../commands/config/set.js');
			await ConfigSet.run(['myKey', 'myValue', '--dry-run', '--json']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('Would set');
		});
	});

	describe('config unset --json --dry-run', () => {
		it('outputs valid JSON showing what would be unset', async () => {
			const {unsetConfigValue} = await import('@wip/shared');
			vi.mocked(unsetConfigValue).mockReturnValue(true);

			const {default: ConfigUnset} = await import('../commands/config/unset.js');
			await ConfigUnset.run(['myKey', '--dry-run', '--json']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('key', 'myKey');
			expect(parsed).toHaveProperty('dryRun', true);
			expect(parsed).toHaveProperty('found', true);
		});

		it('does not mutate config in dry-run mode', async () => {
			const {unsetConfigValue, getConfigValue} = await import('@wip/shared');
			vi.mocked(unsetConfigValue).mockClear();
			vi.mocked(getConfigValue).mockReturnValue('someValue');

			const {default: ConfigUnset} = await import('../commands/config/unset.js');
			await ConfigUnset.run(['myKey', '--dry-run']);

			expect(unsetConfigValue).not.toHaveBeenCalled();
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: ConfigUnset} = await import('../commands/config/unset.js');
			await ConfigUnset.run(['myKey', '--dry-run', '--json']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('Would remove');
		});
	});

	describe('serve --json', () => {
		it('outputs only valid JSON to stdout with --dry-run', async () => {
			const {default: Serve} = await import('../commands/serve.js');
			await Serve.run(['--json', '--dry-run']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('port');
			expect(parsed).toHaveProperty('webDir');
			expect(parsed).toHaveProperty('dryRun', true);
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: Serve} = await import('../commands/serve.js');
			await Serve.run(['--json', '--dry-run']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			expect(stripped).not.toContain('Would start');
			expect(stripped).not.toContain('web directory');
		});
	});

	describe('config get --json', () => {
		it('outputs only valid JSON to stdout when listing all config', async () => {
			const {default: ConfigGet} = await import('../commands/config/get.js');
			await ConfigGet.run(['--json']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('projectsDir');
			expect((parsed as any).projectsDir).toBe('/tmp/fake-projects');
		});

		it('outputs only valid JSON to stdout for a single key', async () => {
			const {default: ConfigGet} = await import('../commands/config/get.js');
			await ConfigGet.run(['projectsDir', '--json']);

			const output = capture.getOutput();
			const parsed = assertValidJsonOutput(output);

			expect(parsed).toHaveProperty('projectsDir');
		});

		it('includes no human-readable output when --json is passed', async () => {
			const {default: ConfigGet} = await import('../commands/config/get.js');
			await ConfigGet.run(['--json']);

			const output = capture.getOutput();
			const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
			// Should not contain key=value format
			expect(stripped).not.toContain('projectsDir=');
		});
	});
});
