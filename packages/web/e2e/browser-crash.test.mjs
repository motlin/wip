import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {afterEach, describe, expect, it} from "vite-plus/test";

import {chromiumCrashReportsSince, summarizeCrashReport, waitForChromiumCrashReports} from "./browser-crash.mjs";

/** A macOS .ips crash report: a JSON header line, then the JSON body (trimmed to the fields read). */
function ipsReport({
	name = "chrome-headless-shell",
	// macOS anonymizes the path: the user and the ms-playwright cache directory are masked.
	procPath = `/Users/USER/Library/Caches/*/${name}`,
	launched,
	captured,
	pid = 20059,
	faultingThread = 0,
}) {
	const header = {app_name: name, timestamp: captured, name};
	const body = {
		procName: name,
		procPath,
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

	it("lists Playwright Chromium crash reports captured after the time, oldest first, and skips other processes and other apps' Chromium", () => {
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
		write(
			"chrome_crashpad_handler-2026-11-05-141200.ips",
			ipsReport({
				name: "chrome_crashpad_handler",
				procPath:
					"/Applications/Wispr Flow.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
				launched: "2026-11-05 14:12:00.0000 -0500",
				captured: "2026-11-05 14:12:00.0000 -0500",
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

describe("waitForChromiumCrashReports", () => {
	let dir;

	afterEach(() => {
		fs.rmSync(dir, {recursive: true, force: true});
	});

	const report = {
		launched: "2026-11-05 14:09:01.5001 -0500",
		captured: "2026-11-05 14:10:15.3796 -0500",
	};

	it("waits for the report macOS writes seconds after the crash was seen", async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-crash-reports-"));
		const file = path.join(dir, "chrome-headless-shell-2026-11-05-141038.ips");
		setTimeout(() => fs.writeFileSync(file, ipsReport(report)), 100);

		expect(
			await waitForChromiumCrashReports(Date.parse("2026-11-05T19:00:00Z"), {
				crashSeen: true,
				timeoutMs: 5000,
				pollMs: 20,
				dir,
			}),
		).toEqual([
			{
				file,
				process: "chrome-headless-shell",
				pid: 20059,
				launched: "2026-11-05 14:09:01.5001 -0500",
				captured: "2026-11-05 14:10:15.3796 -0500",
				exception: "EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x00000000000005c0",
				thread: "CrRendererMain",
			},
		]);
	});

	it("gives up after the timeout when no report appears", async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-crash-reports-"));
		const started = Date.now();

		expect(await waitForChromiumCrashReports(0, {crashSeen: true, timeoutMs: 150, pollMs: 20, dir})).toEqual([]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(150);
	});

	it("does not wait when no crash was seen", async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-crash-reports-"));
		const started = Date.now();

		expect(await waitForChromiumCrashReports(0, {crashSeen: false, timeoutMs: 5000, dir})).toEqual([]);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
