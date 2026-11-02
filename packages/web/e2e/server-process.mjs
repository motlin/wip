/**
 * Process trees for the landing harness: the wip server it starts (and everything that server
 * starts: git test runs, claude, gh) must never outlive the harness. Each tree runs in its own
 * process group, killed as a group by stopProcessTree and, on every other way out of the harness
 * (uncaught error, process.exit, SIGINT/SIGTERM/SIGHUP), by an exit hook.
 */
import {spawn, spawnSync} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Process group ids of trees that are still running. */
const liveGroups = new Set();
let hooksInstalled = false;

function killGroup(pgid, signal)
{
	try
	{
		process.kill(-pgid, signal);
	}
	catch
	{
		// the group is already gone
	}
}

function installExitHooks()
{
	if (hooksInstalled) return;
	hooksInstalled = true;
	process.once("exit", () =>
	{
		for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
	});
	for (const [signal, number] of [
		["SIGHUP", 1],
		["SIGINT", 2],
		["SIGTERM", 15],
	])
	{
		process.once(signal, () =>
		{
			process.exit(128 + number);
		});
	}
}

/** spawn() in a new process group that dies with the harness. */
export function startProcessTree(command, args, options)
{
	installExitHooks();
	const child = spawn(
		command,
		args,
		{
			...options,
			detached: true,
		},
	);
	if (child.pid !== undefined) liveGroups.add(child.pid);
	return child;
}

function exited(child)
{
	return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM the tree's whole group, SIGKILL it if the leader is still up after 10s, and SIGKILL any stragglers. */
export async function stopProcessTree(child, graceMs = 10_000)
{
	const pgid = child.pid;
	if (pgid === undefined) return;
	if (!exited(child))
	{
		const done = new Promise((resolve) =>
		{
			child.once("exit", resolve);
		});
		killGroup(pgid, "SIGTERM");
		let timer;
		const timedOut = new Promise((resolve) =>
		{
			timer = setTimeout(() =>
			{
				resolve("timeout");
			}, graceMs);
		});
		if ((await Promise.race([done, timedOut])) === "timeout")
		{
			killGroup(pgid, "SIGKILL");
			await done;
		}
		clearTimeout(timer);
	}
	killGroup(pgid, "SIGKILL");
	liveGroups.delete(pgid);
}

/**
 * Pids of this user's processes that started no earlier than `sinceMs` (`ps` start times have
 * one-second resolution, so a process from the same second counts).
 */
function processesStartedSince(sinceMs)
{
	const cutoff = Math.floor(sinceMs / 1000) * 1000;
	const uid = process.getuid();
	const result = spawnSync(
		"ps",
		["-axo", "pid=,uid=,lstart="],
		{
			encoding: "utf8",
			env:
			{
				...process.env,
				LC_ALL: "C",
			},
		},
	);
	return result.stdout
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
		.filter((match) => match !== null && Number(match[2]) === uid && Date.parse(match[3]) >= cutoff)
		.map((match) => Number(match[1]));
}

/**
 * Prints the pids among argv[3:] with a file descriptor open on the vnode whose device and inode
 * are argv[1] and argv[2], asking the kernel (libproc) for each pid's descriptors one at a time.
 */
const HOLDERS_SCRIPT = `
import ctypes, sys
libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
PROC_PIDLISTFDS, PROX_FDTYPE_VNODE, PROC_PIDFDVNODEINFO, VNODE_FDINFO_SIZE = 1, 1, 1, 176
dev, ino = int(sys.argv[1]), int(sys.argv[2])
for pid in map(int, sys.argv[3:]):
    size = libproc.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, None, 0)
    if size <= 0:
        continue
    fds = ctypes.create_string_buffer(size)
    size = libproc.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, size)
    for offset in range(0, max(size, 0), 8):
        fd = int.from_bytes(fds.raw[offset:offset + 4], "little", signed=True)
        if int.from_bytes(fds.raw[offset + 4:offset + 8], "little") != PROX_FDTYPE_VNODE:
            continue
        info = ctypes.create_string_buffer(VNODE_FDINFO_SIZE)
        if libproc.proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEINFO, info, VNODE_FDINFO_SIZE) != VNODE_FDINFO_SIZE:
            continue
        if int.from_bytes(info.raw[24:28], "little") == dev and int.from_bytes(info.raw[32:40], "little") == ino:
            print(pid)
            break
`;

/**
 * Pids of every process holding `file` open, or [] when the file is missing or nothing has it open.
 * Only this user's processes started since `file`'s directory was created are asked: the world's
 * files can only be held by processes the harness started after creating it. A machine-wide scan
 * reads every process's file table and blocks, for tens of seconds, on any process stuck in the
 * kernel (an rsync writing to a network share), so it is never load-independent.
 * lsof is never used: for any open file it getattrlist()s every mount point first, whatever its
 * flags (-b included), which blocks for as long as any mounted network share stalls. The kernel's
 * per-descriptor vnode info touches only the candidates' own files.
 */
export function processesHolding(file)
{
	if (!fs.existsSync(file)) return [];
	const candidates = processesStartedSince(fs.statSync(path.dirname(file)).birthtimeMs);
	if (candidates.length === 0) return [];
	const {dev, ino} = fs.statSync(file);
	const result = spawnSync(
		"python3",
		["-I", "-c", HOLDERS_SCRIPT, String(dev), String(ino), ...candidates.map(String)],
		{
			encoding: "utf8",
		},
	);
	if (result.status !== 0) throw new Error(`listing the holders of ${file} failed: ${result.stderr || result.error}`);
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map(Number)
		.toSorted((a, b) => a - b);
}
