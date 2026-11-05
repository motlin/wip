/**
 * Chromium crash reports for the landing harness. Playwright only says "Target crashed"; macOS
 * writes the crashed process's report (exception, crashed thread, lifetime) to
 * ~/Library/Logs/DiagnosticReports, so the harness prints the reports a run produced.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIAGNOSTIC_REPORTS = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");

/** A .ips report's process, lifetime, exception and crashed thread. */
export function summarizeCrashReport(text) {
	const body = JSON.parse(text.slice(text.indexOf("\n") + 1));
	const {type, signal, subtype} = body.exception;
	return {
		process: body.procName,
		pid: body.pid,
		launched: body.procLaunch,
		captured: body.captureTime,
		exception: [type, signal, subtype].filter(Boolean).join(" "),
		thread: body.threads[body.faultingThread]?.name,
	};
}

/** Parses an .ips capture time like "2026-11-05 14:10:15.3796 -0500" to epoch ms. */
function captureTimeMs(captured) {
	const [date, time, zone] = captured.split(" ");
	return Date.parse(`${date}T${time.slice(0, 12)}${zone.slice(0, 3)}:${zone.slice(3)}`);
}

/** Chromium crash reports captured at or after `sinceMs`, oldest first. */
export function chromiumCrashReportsSince(sinceMs, dir = DIAGNOSTIC_REPORTS) {
	let files;
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return files
		.filter((file) => file.endsWith(".ips") && /^(chrome|chromium)/i.test(file))
		.flatMap((file) => {
			try {
				const report = summarizeCrashReport(fs.readFileSync(path.join(dir, file), "utf8"));
				return captureTimeMs(report.captured) >= sinceMs ? [{file: path.join(dir, file), ...report}] : [];
			} catch {
				return [];
			}
		})
		.toSorted((a, b) => captureTimeMs(a.captured) - captureTimeMs(b.captured));
}
