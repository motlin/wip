#!/usr/bin/env node
/**
 * The landing harness's stand-in for `gh`, first on the server's PATH: appends every call to
 * $WIP_E2E_GH_LOG (one JSON line each) and answers from canned data or the fake GitHub at
 * $WIP_E2E_FAKE_GITHUB. It never runs the real gh or reaches GitHub.
 */
import {appendFileSync} from "node:fs";

const args = process.argv.slice(2);
const log = process.env.WIP_E2E_GH_LOG;
const fakeGitHub = process.env.WIP_E2E_FAKE_GITHUB;
if (log) appendFileSync(log, `${JSON.stringify({args, cwd: process.cwd()})}\n`);

function flag(name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

const [command, subcommand] = args;

if (command === "auth" && subcommand === "token") {
	process.stdout.write("fake-gh-token\n");
} else if (command === "auth" && subcommand === "status") {
	process.stdout.write("Logged in to github.com as e2e-user (fake)\n");
} else if (command === "pr" && subcommand === "merge") {
	const number = args[2];
	const repository = flag("-R") ?? flag("--repo");
	if (args.includes("--auto")) {
		if (!fakeGitHub) fail("fake gh: WIP_E2E_FAKE_GITHUB is not set");
		const response = await fetch(`${fakeGitHub}/fake/auto-merge`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({repository, number}),
		});
		if (!response.ok) fail(`fake gh: no PR #${number} in ${repository}`);
	}
	process.stdout.write(`Merged pull request #${number} (fake)\n`);
} else if (command === "pr" && subcommand === "view") {
	process.stdout.write(`${JSON.stringify({number: 1, state: "OPEN", url: `${fakeGitHub}/pull/1`})}\n`);
} else if (command === "pr" && subcommand === "create") {
	process.stdout.write(`${fakeGitHub}/pull/1\n`);
} else if (command === "api" && subcommand === "user") {
	process.stdout.write(`${JSON.stringify({login: "e2e-user"})}\n`);
} else if (command === "api" && subcommand?.startsWith("repos/")) {
	process.stdout.write(`${JSON.stringify({allow_auto_merge: true, private: false})}\n`);
} else {
	fail(`fake gh: unsupported command: gh ${args.join(" ")}`);
}
