import {beforeEach, describe, expect, it, vi} from "vite-plus/test";

const {mockedExeca} = vi.hoisted(() => ({
	mockedExeca: vi.fn<(command: string, args: readonly string[], options?: object) => Promise<unknown>>(),
}));

vi.mock("execa", () => ({execa: mockedExeca}));

import {runFetchRung, runReplayRung, type LadderRungProject} from "./ladder-rungs.js";

const project: LadderRungProject = {
	name: "p",
	path: "/tmp/does-not-exist-p",
	upstreamRemote: "upstream",
	upstreamBranch: "main",
};

function ok(stdout: string, exitCode = 0) {
	return {stdout, stderr: "", exitCode, failed: exitCode !== 0, command: "just"};
}

beforeEach(() => {
	mockedExeca.mockReset();
});

describe("runFetchRung", () => {
	it("runs the global fetch recipe in the project dir with upstream env", async () => {
		mockedExeca.mockResolvedValue(ok(""));
		const result = await runFetchRung(project);
		expect(mockedExeca).toHaveBeenCalledTimes(1);
		const [cmd, args, options] = mockedExeca.mock.calls[0]!;
		expect({cmd, args, options}).toEqual({
			cmd: "just",
			args: ["--global-justfile", "fetch"],
			options: {
				cwd: "/tmp/does-not-exist-p",
				env: {
					UPSTREAM_REMOTE: "upstream",
					UPSTREAM_BRANCH: "main",
					TERM: process.env["TERM"] ?? "xterm-256color",
				},
				extendEnv: true,
				reject: false,
			},
		});
		expect(result).toEqual({project: "p", rungs: [{rung: "fetch", status: "passed", detail: "fetched upstream"}]});
	});

	it("stops with an error when fetch fails", async () => {
		mockedExeca.mockResolvedValue({...ok("", 1), stderr: "fatal: unable to access"});
		const result = await runFetchRung(project);
		expect(result).toEqual({
			project: "p",
			rungs: [{rung: "fetch", status: "stopped", detail: "fatal: unable to access"}],
			stop: {stop: "error", branches: []},
		});
	});
});

describe("runReplayRung", () => {
	it("passes when no branch fails, running with KEEP_GOING true", async () => {
		mockedExeca.mockResolvedValue(ok("[1/1] Replaying branch a onto upstream/main"));
		const result = await runReplayRung(project);
		const [cmd, args] = mockedExeca.mock.calls[0]!;
		expect({cmd, args}).toEqual({cmd: "just", args: ["--global-justfile", "replay-all", "true"]});
		expect(result).toEqual({project: "p", rungs: [{rung: "replay", status: "passed", detail: "replayed"}]});
	});

	it("parses the failed branch list into a conflict stop", async () => {
		const esc = String.fromCharCode(27);
		mockedExeca.mockResolvedValue(
			ok(
				[
					"[2/2] Failed to replay branch b (conflict)",
					"",
					`${esc}[31m${esc}[1mFailed to replay 2 branch(es):${esc}[0m`,
					`  ${esc}[31m-${esc}(B${esc}[m ${esc}[92m${esc}[1mfeature/b${esc}[0m`,
					"  - c",
				].join("\n"),
			),
		);
		const result = await runReplayRung(project);
		expect(result).toEqual({
			project: "p",
			rungs: [{rung: "replay", status: "stopped", detail: "failed to replay 2 branch(es)"}],
			stop: {stop: "conflict", branches: ["feature/b", "c"]},
		});
	});

	it("stops with an error when the recipe fails without a branch list", async () => {
		mockedExeca.mockResolvedValue({...ok("", 2), stderr: "boom"});
		const result = await runReplayRung(project);
		expect(result).toEqual({
			project: "p",
			rungs: [{rung: "replay", status: "stopped", detail: "boom"}],
			stop: {stop: "error", branches: []},
		});
	});
});
