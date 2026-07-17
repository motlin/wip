import {execa} from "execa";

import {log} from "../services/logger-pino.js";
import {createGate} from "./concurrency.js";
import {getBranchNames, setBranchName} from "./db.js";

interface NamingRequest {
	sha: string;
	project: string;
	subject: string;
	dir: string;
}

// One process-wide budget for `claude -p` branch naming. Every caller (per-child
// suggestion, the unawaited refresh fan-out, the CLI) draws from this, so a burst
// of concurrent project refreshes can never spawn more than a handful of heavy
// claude processes at once — the escape hatch that pegged the machine.
const NAMING_GATE_LIMIT = 3;
const namingGate = createGate(NAMING_GATE_LIMIT);

export async function nameBranch(req: NamingRequest): Promise<string | null> {
	const prompt = `You are naming a git branch for a single commit.

Run: git -C ${req.dir} show --stat ${req.sha}

Then output a single descriptive kebab-case branch name (3-6 words) that captures WHAT changed specifically. Be concrete — "deprecate-commons-lang2-dependency" not "deprecate". No prefixes, no explanation, just the branch name.`;

	const start = performance.now();
	const result = await namingGate(() =>
		execa("claude", ["-p", "--no-session-persistence", prompt], {
			reject: false,
			timeout: 60_000,
			input: "",
		}),
	);
	const duration = Math.round(performance.now() - start);
	log.subprocess.debug(
		{cmd: "claude", args: ["-p", "..."], duration},
		`claude -p branch naming for ${req.sha.slice(0, 7)} (${duration}ms)`,
	);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		return null;
	}

	// Take the last non-empty line (Claude may prefix with thinking)
	const lines = result.stdout
		.trim()
		.split("\n")
		.filter((l) => l.trim());
	const lastLine = lines[lines.length - 1];
	if (!lastLine) return null;
	const name = lastLine.trim();
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

	// nameBranch draws from the module-global naming gate, so fire them all at
	// once and let that shared budget — not a per-call batch — bound the fan-out.
	const names = await Promise.all(uncached.map((req) => nameBranch(req)));
	for (let i = 0; i < uncached.length; i++) {
		const name = names[i];
		const req = uncached[i];
		if (name && req) {
			const key = `${req.project}:${req.sha}`;
			result.set(key, name);
			setBranchName(req.sha, req.project, name);
		}
	}

	return result;
}
