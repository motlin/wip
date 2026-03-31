import {execa} from 'execa';
import {getMiseEnv, getTestLogDir, log, recordTestResult} from '@wip/shared';
import {EventEmitter} from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type JobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';

export interface TestJob {
	id: string;
	project: string;
	projectDir: string;
	sha: string;
	shortSha: string;
	subject: string;
	branch?: string;
	status: JobStatus;
	message?: string;
	queuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface JobEvent {
	id: string;
	sha: string;
	project: string;
	shortSha: string;
	subject: string;
	branch?: string;
	status: JobStatus;
	message?: string;
	type?: 'status' | 'log';
	log?: string;
}

let nextId = 1;
const jobs = new Map<string, TestJob>();
const projectQueues = new Map<string, string[]>();
const runningProjects = new Set<string>();
const runningProcesses = new Map<string, {kill: () => void}>();

export const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function emit(job: TestJob): void {
	const event: JobEvent = {id: job.id, sha: job.sha, project: job.project, shortSha: job.shortSha, subject: job.subject, branch: job.branch, status: job.status, message: job.message, type: 'status'};
	emitter.emit('job', event);
}

function emitLog(job: TestJob, chunk: string): void {
	const event: JobEvent = {id: job.id, sha: job.sha, project: job.project, shortSha: job.shortSha, subject: job.subject, branch: job.branch, status: job.status, type: 'log', log: chunk};
	emitter.emit('job', event);
}

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
	emit(job);

	runTest(job).then(() => {
		queue.shift();
		runningProjects.delete(project);
		processQueue(project);
	}).catch((err) => {
		job.status = 'failed';
		job.message = `${job.shortSha} failed: ${err instanceof Error ? err.message : 'unknown error'}`;
		job.finishedAt = Date.now();
		emit(job);
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
	const childProcess = execa('git', ['-C', job.projectDir, 'test', 'run', '--retest', job.sha], {
		reject: false,
		env: {...miseEnv, FORCE_COLOR: '1', CLICOLOR_FORCE: '1'},
		buffer: true,
	});
	runningProcesses.set(job.id, {kill: () => childProcess.kill('SIGTERM')});

	if (childProcess.stdout) {
		childProcess.stdout.on('data', (chunk: Buffer) => {
			emitLog(job, chunk.toString());
		});
	}
	if (childProcess.stderr) {
		childProcess.stderr.on('data', (chunk: Buffer) => {
			emitLog(job, chunk.toString());
		});
	}

	const result = await childProcess;
	runningProcesses.delete(job.id);

	// If the job was cancelled while running, don't overwrite the cancelled status
	if (job.status === 'cancelled') return;

	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'git', args: ['-C', job.projectDir, 'test', 'run', '--retest', job.sha], duration}, `git -C ${job.projectDir} test run --retest ${job.sha} (${duration}ms)`);

	const logContent = [result.stdout, result.stderr].filter(Boolean).join('\n');
	const logPath = path.join(logDir, `${job.sha}.log`);
	fs.writeFileSync(logPath, logContent + '\n');

	job.finishedAt = Date.now();
	const status = result.exitCode === 0 ? 'passed' : 'failed';
	job.status = status;
	job.message = status === 'passed' ? `${job.shortSha} passed` : `${job.shortSha} failed (exit ${result.exitCode})`;

	recordTestResult(job.sha, job.project, status, result.exitCode ?? 1, duration);
	emit(job);
}

export function enqueueTest(project: string, projectDir: string, sha: string, shortSha: string, subject?: string, branch?: string): TestJob {
	const existing = findJob(sha, project);
	if (existing && (existing.status === 'queued' || existing.status === 'running')) {
		return existing;
	}

	const id = String(nextId++);
	const job: TestJob = {id, project, projectDir, sha, shortSha, subject: subject ?? shortSha, branch, status: 'queued', queuedAt: Date.now()};

	jobs.set(id, job);
	if (!projectQueues.has(project)) {
		projectQueues.set(project, []);
	}
	projectQueues.get(project)!.push(id);

	emit(job);
	processQueue(project);
	return job;
}

export function findJob(sha: string, project: string): TestJob | undefined {
	for (const job of jobs.values()) {
		if (job.sha === sha && job.project === project) return job;
	}
	return undefined;
}

export function getAllActiveJobs(): TestJob[] {
	return Array.from(jobs.values()).filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getAllJobs(): Map<string, TestJob> {
	return jobs;
}

export function cancelTest(id: string): {ok: boolean; message: string} {
	const job = jobs.get(id);
	if (!job) return {ok: false, message: 'Job not found'};
	if (job.status === 'passed' || job.status === 'failed' || job.status === 'cancelled') {
		return {ok: false, message: `Job already ${job.status}`};
	}

	if (job.status === 'queued') {
		// Remove from the project queue
		const queue = projectQueues.get(job.project);
		if (queue) {
			const idx = queue.indexOf(id);
			if (idx !== -1) queue.splice(idx, 1);
		}
		job.status = 'cancelled';
		job.finishedAt = Date.now();
		job.message = `${job.shortSha} cancelled`;
		emit(job);
		return {ok: true, message: job.message};
	}

	if (job.status === 'running') {
		// Kill the child process
		const proc = runningProcesses.get(id);
		if (proc) {
			proc.kill();
			runningProcesses.delete(id);
		}
		job.status = 'cancelled';
		job.finishedAt = Date.now();
		job.message = `${job.shortSha} cancelled`;
		emit(job);
		return {ok: true, message: job.message};
	}

	return {ok: false, message: 'Unknown job status'};
}
