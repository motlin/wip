import {execa} from 'execa';
import {getMiseEnv, getTestLogDir, log} from '@wip/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type JobStatus = 'queued' | 'running' | 'passed' | 'failed';

export interface TestJob {
	id: string;
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	status: JobStatus;
	message?: string;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

let nextId = 1;
const jobs = new Map<string, TestJob>();
const projectQueues = new Map<string, string[]>(); // project -> job IDs
const runningProjects = new Set<string>();

function processQueue(project: string): void {
	if (runningProjects.has(project)) return;

	const queue = projectQueues.get(project);
	if (!queue || queue.length === 0) return;

	const jobId = queue[0];
	const job = jobs.get(jobId);
	if (!job) {
		queue.shift();
		return;
	}

	runningProjects.add(project);
	job.status = 'running';
	job.startedAt = Date.now();

	runTest(job).then(() => {
		queue.shift();
		runningProjects.delete(project);
		processQueue(project);
	});
}

async function runTest(job: TestJob): Promise<void> {
	const miseEnv = await getMiseEnv(job.projectDir);
	const logDir = getTestLogDir(job.project);
	fs.mkdirSync(logDir, {recursive: true});

	const start = performance.now();
	const result = await execa('git', ['-C', job.projectDir, 'test', 'run', '--force', job.sha], {
		reject: false,
		env: miseEnv,
	});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', job.projectDir, 'test', 'run', '--force', job.sha], duration}, `git -C ${job.projectDir} test run --force ${job.sha} (${duration}ms)`);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
	const logPath = path.join(logDir, `${job.sha}.log`);
	fs.writeFileSync(logPath, logContent + '\n');

	job.finishedAt = Date.now();
	if (result.exitCode === 0) {
		job.status = 'passed';
		job.message = `${job.shortSha} passed`;
	} else {
		job.status = 'failed';
		job.message = `${job.shortSha} failed (exit ${result.exitCode})`;
	}
}

export function enqueueTest(project: string, projectDir: string, sha: string, shortSha: string): TestJob {
	// Check if this sha is already queued or running
	const existing = findJob(sha, project);
	if (existing && (existing.status === 'queued' || existing.status === 'running')) {
		return existing;
	}

	const id = String(nextId++);
	const job: TestJob = {
		id,
		project,
		projectDir,
		sha,
		shortSha,
		status: 'queued',
		queuedAt: Date.now(),
	};

	jobs.set(id, job);

	if (!projectQueues.has(project)) {
		projectQueues.set(project, []);
	}
	projectQueues.get(project)!.push(id);

	processQueue(project);
	return job;
}

export function findJob(sha: string, project: string): TestJob | undefined {
	for (const job of jobs.values()) {
		if (job.sha === sha && job.project === project) return job;
	}
	return undefined;
}

export function getQueuePosition(jobId: string): number {
	const job = jobs.get(jobId);
	if (!job) return -1;
	const queue = projectQueues.get(job.project);
	if (!queue) return -1;
	return queue.indexOf(jobId);
}

export function getProjectQueueLength(project: string): number {
	return projectQueues.get(project)?.length ?? 0;
}

export function getAllActiveJobs(): TestJob[] {
	return Array.from(jobs.values()).filter((j) => j.status === 'queued' || j.status === 'running');
}
