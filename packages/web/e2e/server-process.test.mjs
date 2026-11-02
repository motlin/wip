import {spawn} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {afterEach, describe, expect, it} from "vite-plus/test";

import {processesHolding, startProcessTree, stopProcessTree} from "./server-process.mjs";

const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "server-process.mjs")).href;

/** A shell that backgrounds a sleep holding `file` open, prints the sleep's pid, then waits: a server with a child. */
function treeScript(file)
{
	return `sleep 300 3<"${file}" & echo $!; wait`;
}

function alive(pid)
{
	try
	{
		process.kill(pid, 0);
		return true;
	}
	catch
	{
		return false;
	}
}

async function waitUntil(condition, what)
{
	const deadline = Date.now() + 10_000;
	while (!condition())
	{
		if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
		// eslint-disable-next-line no-await-in-loop -- polls the condition
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 50);
		});
	}
}

const strays = [];
let dir = "";

function heldFile()
{
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-server-process-"));
	const file = path.join(dir, "wip.db");
	fs.writeFileSync(file, "");
	return file;
}

afterEach(() =>
{
	for (const pid of strays.splice(0))
	{
		try
		{
			process.kill(pid, "SIGKILL");
		}
		catch
		{
			// already gone
		}
	}
	if (dir !== "")
		fs.rmSync(
			dir,
			{
				recursive: true,
				force: true,
			},
		);
	dir = "";
});

/**
 * Runs a harness stand-in that starts a process tree, prints the grandchild's pid, then does `then`
 * (JS source), and resolves with that pid and the harness's exit once the harness exits.
 */
async function runHarness(file, then, signal)
{
	const harness = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {startProcessTree} from ${JSON.stringify(moduleUrl)};
			const tree = startProcessTree("sh", ["-c", ${JSON.stringify(treeScript(file))}], {stdio: ["ignore", "pipe", "inherit"]});
			tree.stdout.once("data", (chunk) => { process.stdout.write(chunk); ${then} });
			setInterval(() => {}, 1000);`,
		],
		// stderr is ignored: one stand-in dies of an uncaught error on purpose.
		{
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	const grandchild = await new Promise((resolve) =>
	{
		harness.stdout.once("data", (chunk) =>
		{
			resolve(Number(chunk.toString().trim()));
		});
	});
	strays.push(grandchild);
	const exited = new Promise((resolve) =>
	{
		harness.once("exit", (code, exitSignal) =>
		{
			resolve(
				{
					code,
					signal: exitSignal,
				},
			);
		});
	});
	if (signal !== undefined) harness.kill(signal);
	return {
		grandchild,
		exit: await exited,
	};
}

describe("startProcessTree", () =>
{
	it.each(["SIGTERM", "SIGINT", "SIGHUP"])("kills the whole tree when the harness gets %s", async (signal) =>
	{
		const file = heldFile();
		const {grandchild, exit} = await runHarness(file, "", signal);
		expect(exit).toStrictEqual(
			{
				code: signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 129,
				signal: null,
			},
		);
		await waitUntil(() => !alive(grandchild), "the grandchild is gone");
		expect(processesHolding(file)).toStrictEqual([]);
	});

	it("kills the whole tree when the harness dies of an uncaught error", async () =>
	{
		const file = heldFile();
		const {grandchild, exit} = await runHarness(file, `throw new Error("assertion failed");`);
		expect(exit).toStrictEqual(
			{
				code: 1,
				signal: null,
			},
		);
		await waitUntil(() => !alive(grandchild), "the grandchild is gone");
		expect(processesHolding(file)).toStrictEqual([]);
	});

	it("kills the whole tree when the harness calls process.exit", async () =>
	{
		const file = heldFile();
		const {grandchild, exit} = await runHarness(file, "process.exit(3);");
		expect(exit).toStrictEqual(
			{
				code: 3,
				signal: null,
			},
		);
		await waitUntil(() => !alive(grandchild), "the grandchild is gone");
		expect(processesHolding(file)).toStrictEqual([]);
	});
});

describe("stopProcessTree", () =>
{
	it("stops the leader and its children, so nothing holds the world's files", async () =>
	{
		const file = heldFile();
		const tree = startProcessTree(
			"sh",
			["-c", treeScript(file)],
			{
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		const grandchild = await new Promise((resolve) =>
		{
			tree.stdout.once("data", (chunk) =>
			{
				resolve(Number(chunk.toString().trim()));
			});
		});
		strays.push(grandchild);
		await waitUntil(() => processesHolding(file).length > 0, "the grandchild holds the file");
		expect(processesHolding(file)).toStrictEqual([grandchild]);

		await stopProcessTree(tree);

		expect(tree.exitCode !== null || tree.signalCode !== null).toBe(true);
		await waitUntil(() => !alive(grandchild), "the grandchild is gone");
		expect(processesHolding(file)).toStrictEqual([]);
	});

	it("returns at once for a tree that already exited", async () =>
	{
		const tree = startProcessTree(
			"sh",
			["-c", "exit 0"],
			{
				stdio: "ignore",
			},
		);
		await new Promise((resolve) =>
		{
			tree.once("exit", resolve);
		});
		await stopProcessTree(tree);
		expect(tree.exitCode).toBe(0);
	});
});

describe("processesHolding", () =>
{
	it("is empty for a file nothing has open, and for a file that does not exist", () =>
	{
		const file = heldFile();
		expect(processesHolding(file)).toStrictEqual([]);
		expect(processesHolding(path.join(dir, "missing.db"))).toStrictEqual([]);
	});

	it("answers at once while another process is stuck in the kernel or a mounted filesystem stalls, by asking only processes started since the file's directory and never touching a mount point", () =>
	{
		const file = heldFile();
		const fd = fs.openSync(file, "r");
		const holder = spawn(
			"sleep",
			["300"],
			{
				stdio: [fd, "ignore", "ignore"],
			},
		);
		fs.closeSync(fd);
		strays.push(holder.pid);
		const started = performance.now();
		const holders = processesHolding(file);
		const elapsed = performance.now() - started;
		expect(
			{
				holders,
				fast: elapsed < 3000,
			},
		).toStrictEqual(
			{
				holders: [holder.pid],
				fast: true,
			},
		);
	});
});
