import {execa} from 'execa';

import {log} from '../services/logger.js';
import {getBranchNames, setBranchName} from './db.js';

interface NamingRequest {
	sha: string;
	project: string;
	subject: string;
}

function subjectToSlug(subject: string): string {
	return subject.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function suggestBranchNames(requests: NamingRequest[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	if (requests.length === 0) return result;

	// Check cache first
	const cached = getBranchNames(requests);
	const uncached: NamingRequest[] = [];
	for (const req of requests) {
		const key = `${req.project}:${req.sha}`;
		const name = cached.get(key);
		if (name) {
			result.set(key, name);
		} else {
			uncached.push(req);
		}
	}

	if (uncached.length === 0) return result;

	// Build prompt for Claude
	const lines = uncached.map((r, i) => `${i + 1}. ${r.subject}`).join('\n');
	const prompt = `Generate short, descriptive git branch names (kebab-case) for these commit subjects. Output exactly one branch name per line, numbered to match. No explanations, no backticks, just the numbered names.

${lines}`;

	const start = performance.now();
	const claudeResult = await execa('claude', ['-p', prompt], {reject: false, timeout: 30_000});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'claude', args: ['-p', '...'], duration}, `claude -p branch naming (${uncached.length} subjects, ${duration}ms)`);

	if (claudeResult.exitCode !== 0 || !claudeResult.stdout.trim()) {
		// Fallback to slug-based names
		for (const req of uncached) {
			const name = subjectToSlug(req.subject);
			result.set(`${req.project}:${req.sha}`, name);
			setBranchName(req.sha, req.project, name);
		}
		return result;
	}

	// Parse Claude's response
	const outputLines = claudeResult.stdout.trim().split('\n');
	for (let i = 0; i < uncached.length; i++) {
		const req = uncached[i];
		const line = outputLines[i]?.trim() ?? '';
		// Strip leading number and punctuation (e.g., "1. branch-name" or "1) branch-name")
		const name = line.replace(/^\d+[.)]\s*/, '').trim() || subjectToSlug(req.subject);
		const key = `${req.project}:${req.sha}`;
		result.set(key, name);
		setBranchName(req.sha, req.project, name);
	}

	return result;
}
