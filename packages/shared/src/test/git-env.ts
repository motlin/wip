// GIT_* variables the test suite itself reads; everything else under GIT_ is dropped.
const SUITE_OWNED_GIT_VARIABLES = new Set(["GIT_FIXTURE_RECORD"]);

/**
 * Strip inherited GIT_* variables so child git processes in tests honor their cwd.
 *
 * When tests run inside a git hook, `git test`, or `git rebase --exec`, git exports GIT_DIR,
 * GIT_WORK_TREE, GIT_INDEX_FILE and friends. Those override cwd, so a helper running
 * `git config user.name ...` in a temp dir would write into the real repo's .git/config instead.
 * It also pins core.fsmonitor=false for every git the tests spawn.
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): void
{
	for (const key of Object.keys(env))
	{
		if (key.startsWith("GIT_") && !SUITE_OWNED_GIT_VARIABLES.has(key))
		{
			Reflect.deleteProperty(env, key);
		}
	}
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	// Command-scope config outranks every config file, including a repo's own: no temp repo starts a
	// git fsmonitor--daemon, whose FSEvents stream outlives the deleted repo and exhausts macOS FSEvents.
	env.GIT_CONFIG_COUNT = "1";
	env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
	env.GIT_CONFIG_VALUE_0 = "false";
}
