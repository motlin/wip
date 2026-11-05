/**
 * Builds the landing harness's throwaway world under one temp directory: bare "GitHub" repos, the
 * user's clones with branches in each landing state, a WIP config and registry pointing at them, and
 * a bin directory of fakes (gh, claude, mise, pmset) to put first on the server's PATH. Its env points
 * HOME, the XDG dirs and WIP_DB_PATH into the temp directory, so nothing reads or writes
 * ~/.config/wip, the real wip.db, real repos, real gh or real remotes.
 */
import {execFileSync} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {fileURLToPath} from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));

/** The test every repo runs: a commit is red while it has a RED file. */
const TEST_COMMAND = "test ! -e RED";

/** The `git children` alias wip expects (also in packages/shared/src/lib/git.test.ts): direct children of a commit. */
const CHILDREN_ALIAS =
	"!PARENT=$(git rev-parse ${1:-HEAD}); git rev-list --all --parents | awk -v p=\"$PARENT\" 'NF==2 && $2==p {print $1}'; :";

function writeExecutable(file, content) {
	fs.writeFileSync(file, content);
	fs.chmodSync(file, 0o755);
}

/** Makes the temp dir and the env every git call and the server run with. */
function createRoot() {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wip-e2e-landing-")));
	const dirs = {
		root,
		home: path.join(root, "home"),
		config: path.join(root, "config"),
		cache: path.join(root, "cache"),
		data: path.join(root, "data"),
		bin: path.join(root, "bin"),
		github: path.join(root, "github"),
		seeds: path.join(root, "seeds"),
		projects: path.join(root, "projects"),
	};
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dirs.home, ".gitconfig"),
		"[user]\n\tname = WIP E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n",
	);
	// wip lists a project's work with `git children`, an alias the user's own git config provides.
	execFileSync("git", ["config", "--file", path.join(dirs.home, ".gitconfig"), "alias.children", CHILDREN_ALIAS]);
	const ghLog = path.join(root, "gh-calls.jsonl");
	const env = {
		...process.env,
		HOME: dirs.home,
		XDG_CONFIG_HOME: dirs.config,
		XDG_CACHE_HOME: dirs.cache,
		XDG_DATA_HOME: dirs.data,
		WIP_DB_PATH: path.join(dirs.data, "wip.db"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: path.join(dirs.home, ".gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		GH_CONFIG_DIR: path.join(dirs.config, "gh"),
		WIP_E2E_GH_LOG: ghLog,
		PATH: `${dirs.bin}:${process.env.PATH ?? ""}`,
	};
	delete env.GITHUB_TOKEN;
	delete env.GH_TOKEN;
	delete env.WIP_READY_BUFFER;
	delete env.WIP_TRACING;
	delete env.UPSTREAM_REMOTE;
	delete env.UPSTREAM_BRANCH;
	return {dirs, env, ghLog};
}

function writeFakes(bin) {
	writeExecutable(
		path.join(bin, "gh"),
		`#!/bin/sh\nexec "${process.execPath}" "${path.join(e2eDir, "fake-gh.mjs")}" "$@"\n`,
	);
	// Branch naming and other claude calls fail fast; every branch here is already named.
	writeExecutable(
		path.join(bin, "claude"),
		'#!/bin/sh\nprintf \'%s\\n\' "claude $*" >> "$(dirname "$WIP_E2E_GH_LOG")/claude-calls.log"\necho "fake claude: refused" >&2\nexit 1\n',
	);
	writeExecutable(path.join(bin, "mise"), "#!/bin/sh\necho '{}'\n");
	// Always on AC power, so the ready buffer runs whatever this machine is plugged into.
	writeExecutable(
		path.join(bin, "pmset"),
		"#!/bin/sh\necho \"Now drawing from 'AC Power'\"\necho ' -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true'\n",
	);
}

/** The registry entry for one of the world's clones. */
function record(repo, landing, priority) {
	return {
		...(priority === undefined ? {} : {priority}),
		name: repo.name,
		dir: repo.clone,
		template: "unknown",
		kind: repo.forkBare === undefined ? "own" : "fork",
		upstreamRemote: repo.forkBare === undefined ? "origin" : "upstream",
		upstreamBranch: "main",
		landing,
		...(repo.verify === undefined ? {} : {verify: repo.verify}),
	};
}

export function createWorld() {
	const {dirs, env, ghLog} = createRoot();
	writeFakes(dirs.bin);

	const git = (cwd, ...args) =>
		execFileSync("git", args, {cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
	const commitFile = (cwd, file, content, message) => {
		fs.writeFileSync(path.join(cwd, file), content);
		git(cwd, "add", "--all");
		git(cwd, "commit", "--quiet", "-m", message);
		return git(cwd, "rev-parse", "HEAD");
	};
	const removeFile = (cwd, file, message) => {
		git(cwd, "rm", "--quiet", file);
		git(cwd, "commit", "--quiet", "-m", message);
		return git(cwd, "rev-parse", "HEAD");
	};
	const bare = (owner, name) => path.join(dirs.github, owner, `${name}.git`);

	/**
	 * One repo: upstream acme/<name> and the user's fork e2e-user/<name> as bare repos, a seed
	 * checkout that plays everyone else pushing upstream, and the user's clone with upstream + origin.
	 */
	/**
	 * With `noFork`, the clone's only remote is origin = acme/<name> itself: branches push to the
	 * upstream repo and PRs open from there, so the GitHub token needs WRITE on it to open them.
	 */
	const repo = (name, {red = false, noFork = false, workflow, verify} = {}) => {
		const upstreamBare = bare("acme", name);
		const forkBare = noFork ? undefined : bare("e2e-user", name);
		for (const dir of [upstreamBare, forkBare].filter((d) => d !== undefined)) {
			fs.mkdirSync(dir, {recursive: true});
			git(dir, "init", "--quiet", "--bare");
		}
		const seed = path.join(dirs.seeds, name);
		fs.mkdirSync(seed);
		git(seed, "init", "--quiet");
		commitFile(seed, "README.md", `# ${name}\n`, `Start ${name}`);
		if (workflow !== undefined) {
			fs.mkdirSync(path.join(seed, ".github", "workflows"), {recursive: true});
			commitFile(seed, path.join(".github", "workflows", "ci.yml"), workflow, `Add ${name}'s CI`);
		}
		if (red) commitFile(seed, "RED", "upstream is broken\n", `Break ${name}'s tests`);
		git(seed, "remote", "add", "upstream", upstreamBare);
		git(seed, "push", "--quiet", "upstream", "main");
		if (forkBare !== undefined) git(seed, "push", "--quiet", forkBare, "main");
		const clone = path.join(dirs.projects, name);
		const upstreamRemote = noFork ? "origin" : "upstream";
		git(dirs.projects, "clone", "--quiet", "--origin", upstreamRemote, upstreamBare, clone);
		if (forkBare !== undefined) {
			git(clone, "remote", "add", "origin", forkBare);
			git(clone, "fetch", "--quiet", "origin");
		}
		git(clone, "config", "test.default.command", TEST_COMMAND);
		const branch = (branchName, file, message) => {
			git(clone, "checkout", "--quiet", "-b", branchName, `${upstreamRemote}/main`);
			const sha = commitFile(clone, file, `${branchName}\n`, message);
			git(clone, "checkout", "--quiet", "main");
			return sha;
		};
		/** Someone else lands a commit upstream; the clone only learns of it when it fetches. */
		const landUpstream = (file, message) => {
			const sha = commitFile(seed, file, `${file}\n`, message);
			git(seed, "push", "--quiet", "upstream", "main");
			return sha;
		};
		return {name, clone, seed, upstreamBare, forkBare, verify, branch, landUpstream};
	};

	// Pull-request repo: one ready commit, one that goes behind upstream after the first Open PR, and
	// one with a PR waiting for checks. Both Open PRs run here, so the second one only works if the
	// first left this repo's rows on the page.
	const widgets = repo("widgets");
	const readySha = widgets.branch("ready-feature", "ready.txt", "Add the ready feature");
	const behindSha = widgets.branch("behind-feature", "behind.txt", "Add the behind feature");
	const waitingSha = widgets.branch("waiting-feature", "waiting.txt", "Add the waiting feature");
	git(widgets.clone, "push", "--quiet", "origin", "waiting-feature");

	// Fast-forward repo: a ready commit that lands by moving local main, then Push main.
	const gadgets = repo("gadgets");
	const ffSha = gadgets.branch("ff-feature", "ff.txt", "Add the fast-forward feature");

	// Red upstream: its line stops, so nothing lands, not even the commit that removes RED.
	const broken = repo("broken", {red: true});
	const fixSha = (() => {
		git(broken.clone, "checkout", "--quiet", "-b", "fix-red", "upstream/main");
		const sha = removeFile(broken.clone, "RED", "Fix broken's tests");
		// The ready buffer tests nothing in a repo whose upstream is red, so the user tested the fix by hand.
		git(broken.clone, "test", "run", "--quiet", sha);
		git(broken.clone, "checkout", "--quiet", "main");
		return sha;
	})();
	const blockedSha = broken.branch("blocked-feature", "blocked.txt", "Add a feature on red upstream");

	// Pull-request repos for the restart: cogs' steady commit lands after the restart before any page opens, and sprockets'
	// stale one goes behind its upstream after the restart, so the buffer must rebase and retest it.
	const cogs = repo("cogs");
	const steadySha = cogs.branch("steady-feature", "steady.txt", "Add the steady feature");
	const sprockets = repo("sprockets");
	const staleSha = sprockets.branch("stale-feature", "stale.txt", "Add the stale feature");

	// Draft-PR verification asked for, but the GitHub token has read-only access to acme/gears (the fake
	// GitHub says READ) and branches push straight to it: it tests locally and says why, and Open PR
	// pushes with git, then sends the tab to GitHub's new-PR page instead of opening the PR itself.
	const gears = repo("gears", {noFork: true, workflow: "on: [push, pull_request]\n", verify: "draft-pr"});
	const gearSha = gears.branch("gear-feature", "gear.txt", "Add the gear feature");

	// A ready target above the number of commits here, so the buffer readies every one of them; acme is
	// the user's own org, so broken's red upstream stops its line.
	const wipConfig = path.join(dirs.config, "wip");
	fs.mkdirSync(wipConfig, {recursive: true});
	const priorities = new Map();
	const writeRegistry = () => {
		const records = [
			[broken, "pull-request"],
			[gadgets, "fast-forward"],
			[widgets, "pull-request"],
			[cogs, "pull-request"],
			[sprockets, "pull-request"],
			[gears, "pull-request"],
		].map(([r, landing]) => record(r, landing, priorities.get(r.name)));
		fs.writeFileSync(path.join(wipConfig, "projects.json5"), `${JSON.stringify(records, null, "\t")}\n`);
	};
	writeRegistry();
	/** Sets one repo's registry priority, read the next time the server loads the registry. */
	const setPriority = (name, priority) => {
		priorities.set(name, priority);
		writeRegistry();
	};
	/** Sets the global ready target the next pull reads. */
	const setReadyTarget = (size) => {
		fs.writeFileSync(
			path.join(wipConfig, "config.json5"),
			`${JSON.stringify({projectsDir: dirs.projects, "readyBuffer.size": String(size), "ownership.orgs": ["acme"]}, null, "\t")}\n`,
		);
	};
	setReadyTarget(10);

	return {
		dirs,
		env,
		ghLog,
		git,
		setReadyTarget,
		setPriority,
		repos: {widgets, gadgets, broken, cogs, sprockets, gears},
		shas: {readySha, behindSha, waitingSha, ffSha, fixSha, blockedSha, steadySha, staleSha, gearSha},
		/** Bare repos the fake GitHub knows, keyed owner/name. */
		fakeRepos: [
			...[widgets, gadgets, broken, cogs, sprockets].flatMap((r) => [
				{owner: "acme", name: r.name, bareDir: r.upstreamBare},
				{owner: "e2e-user", name: r.name, bareDir: r.forkBare, parent: `acme/${r.name}`},
			]),
			{owner: "acme", name: gears.name, bareDir: gears.upstreamBare, viewerPermission: "READ"},
		],
		ghCalls() {
			if (!fs.existsSync(ghLog)) return [];
			return fs
				.readFileSync(ghLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line).args);
		},
		remove() {
			fs.rmSync(dirs.root, {recursive: true, force: true});
		},
	};
}
