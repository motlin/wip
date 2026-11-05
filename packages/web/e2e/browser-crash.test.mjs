import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, describe, expect, it} from "vite-plus/test";

import {chromiumCrashReportsSince, summarizeCrashReport} from "./browser-crash.mjs";

/** A macOS .ips crash report: a JSON header line, then the JSON body (trimmed to the fields read). */
function ipsReport({name = "chrome-headless-shell", launched, captured, pid = 20059, faultingThread = 0}) {
	const header = {app_name: name, timestamp: captured, name};
	const body = {
		procName: name,
		pid,
		parentPid: 19787,
		procLaunch: launched,
		captureTime: captured,
		exception: {
			type: "EXC_BAD_ACCESS",
			signal: "SIGSEGV",
			subtype: "KERN_INVALID_ADDRESS at 0x00000000000005c0",
		},
		faultingThread,
		threads: [{name: "CrRendererMain", queue: "com.apple.main-thread", frames: []}],
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(body)}`;
}

describe("summarizeCrashReport", () => {
	it("reads the process, its lifetime, the exception and the crashed thread", () => {
		expect(
			summarizeCrashReport(
				ipsReport({launched: "2026-11-05 14:09:01.5001 -0500", captured: "2026-11-05 14:10:15.3796 -0500"}),
			),
		).toEqual({
			process: "chrome-headless-shell",
			pid: 20059,
			launched: "2026-11-05 14:09:01.5001 -0500",
			captured: "2026-11-05 14:10:15.3796 -0500",
			exception: "EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x00000000000005c0",
			thread: "CrRendererMain",
		});
	});
});

describe("chromiumCrashReportsSince", () => {
	let dir;

	afterEach(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});

	it("lists Chromium crash reports captured after the time, oldest first, and skips other processes", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-crash-reports-"));
		const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
		write(
			"chrome-headless-shell-2026-11-05-141038.ips",
			ipsReport({launched: "2026-11-05 14:09:01.5001 -0500", captured: "2026-11-05 14:10:15.3796 -0500"}),
		);
		write(
			"chrome-headless-shell-2026-11-05-120000.ips",
			ipsReport({
				launched: "2026-11-05 11:59:00.0000 -0500",
				captured: "2026-11-05 12:00:00.0000 -0500",
				pid: 1,
			}),
		);
		write(
			"Chromium-2026-11-05-142000.ips",
			ipsReport({
				name: "Chromium Helper (Renderer)",
				launched: "2026-11-05 14:19:00.0000 -0500",
				captured: "2026-11-05 14:20:00.0000 -0500",
				pid: 3,
			}),
		);
		write(
			"git-2026-11-05-141100.ips",
			ipsReport({
				name: "git",
				launched: "2026-11-05 14:11:00.0000 -0500",
				captured: "2026-11-05 14:11:00.0000 -0500",
			}),
		);
		write("chrome-headless-shell-2026-11-05-141500.ips", "not a crash report");

		expect(chromiumCrashReportsSince(Date.parse("2026-11-05T19:00:00Z"), dir)).toEqual([
			{
				file: path.join(dir, "chrome-headless-shell-2026-11-05-141038.ips"),
				process: "chrome-headless-shell",
				pid: 20059,
				launched: "2026-11-05 14:09:01.5001 -0500",
				captured: "2026-11-05 14:10:15.3796 -0500",
				exception: "EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x00000000000005c0",
				thread: "CrRendererMain",
			},
			{
				file: path.join(dir, "Chromium-2026-11-05-142000.ips"),
				process: "Chromium Helper (Renderer)",
				pid: 3,
				launched: "2026-11-05 14:19:00.0000 -0500",
				captured: "2026-11-05 14:20:00.0000 -0500",
				exception: "EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x00000000000005c0",
				thread: "CrRendererMain",
			},
		]);
	});

	it("lists nothing when the directory does not exist", () => {
		dir = path.join(os.tmpdir(), "wip-crash-reports-missing");
		expect(chromiumCrashReportsSince(0, dir)).toEqual([]);
	});
});
