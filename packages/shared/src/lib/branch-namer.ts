import { execa } from "execa";

import { log } from "../services/logger.js";
import { getBranchNames, setBranchName } from "./db.js";

interface NamingRequest {
  sha: string;
  project: string;
  subject: string;
  dir: string;
}

export async function nameBranch(req: NamingRequest): Promise<string | null> {
  const prompt = `You are naming a git branch for a single commit.

Run: git -C ${req.dir} show --stat ${req.sha}

Then output a single descriptive kebab-case branch name (3-6 words) that captures WHAT changed specifically. Be concrete — "deprecate-commons-lang2-dependency" not "deprecate". No prefixes, no explanation, just the branch name.`;

  const start = performance.now();
  const result = await execa("claude", ["-p", "--no-session-persistence", prompt], {
    reject: false,
    timeout: 60_000,
    input: "",
  });
  const duration = Math.round(performance.now() - start);
  log.subprocess.debug(
    { cmd: "claude", args: ["-p", "..."], duration },
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

  // Run claude -p calls in parallel (max 3 concurrent to avoid overload)
  const CONCURRENCY = 3;
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY);
    const names = await Promise.all(batch.map((req) => nameBranch(req)));
    for (let j = 0; j < batch.length; j++) {
      const name = names[j];
      const batchItem = batch[j];
      if (name && batchItem) {
        const key = `${batchItem.project}:${batchItem.sha}`;
        result.set(key, name);
        setBranchName(batchItem.sha, batchItem.project, name);
      }
    }
  }

  return result;
}
