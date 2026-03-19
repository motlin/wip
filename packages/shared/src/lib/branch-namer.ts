import {execa} from 'execa';

import {log} from '../services/logger.js';
import {getBranchNames, setBranchName} from './db.js';

interface NamingRequest {
	sha: string;
	project: string;
	subject: string;
	dir: string;
}

async function nameBranch(req: NamingRequest): Promise<string> {
	const prompt = `You are naming a git branch for a single commit.

Run: git -C ${req.dir} show --stat ${req.sha}

Then output a single descriptive kebab-case branch name (3-6 words) that captures WHAT changed specifically. Be concrete — "deprecate-commons-lang2-dependency" not "deprecate". No prefixes, no explanation, just the branch name.`;

	const start = performance.now();
	const result = await execa('claude', ['-p', prompt], {reject: false, timeout: 60_000});
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug({cmd: 'claude', args: ['-p', '...'], duration}, `claude -p branch naming for ${req.sha.slice(0, 7)} (${duration}ms)`);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		throw new Error(`claude -p failed for ${req.sha.slice(0, 7)}: ${result.stderr || 'no output'}`);
	}

	// Take the last non-empty line (Claude may prefix with thinking)
	const lines = result.stdout.trim().split('\n').filter((l) => l.trim());
	const name = lines[lines.length - 1].trim();
	return name;
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

	// One claude -p call per child, no batching
	for (const req of uncached) {
		const key = `${req.project}:${req.sha}`;
		const name = await nameBranch(req);
		result.set(key, name);
		setBranchName(req.sha, req.project, name);
	}

	return result;
}
