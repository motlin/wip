// GIT_* variables the test suite itself reads; everything else under GIT_ is dropped.
const SUITE_OWNED_GIT_VARIABLES = new Set(["GIT_FIXTURE_RECORD"]);

/**
 * Strip inherited GIT_* variables so child git processes in tests honor their cwd.
 *
 * When tests run inside a git hook, `git test`, or `git rebase --exec`, git exports GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE and friends. Those override cwd, so a helper running
 * `git config user.name ...` in a temp dir would write into the real repo's .git/config instead.
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_") && !SUITE_OWNED_GIT_VARIABLES.has(key)) {
			Reflect.deleteProperty(env, key);
		}
	}
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
}
