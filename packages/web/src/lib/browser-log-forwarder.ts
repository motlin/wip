type LogLevel = "log" | "error" | "warn" | "info" | "debug";

interface BufferedEntry {
	level: LogLevel;
	message: string;
	timestamp: string;
}

const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_SIZE = 50;
const MAX_REPEATED_ENTRIES = 3;

let buffer: BufferedEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
const repeatedEntryCounts = new Map<string, number>();

function flush(): void {
	if (buffer.length === 0) return;
	const entries = buffer;
	buffer = [];

	fetch("/api/browser-logs", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(entries),
	}).catch(() => {
		// Silently drop on failure to avoid infinite loops
	});
}

function scheduleFlush(): void {
	if (flushTimer !== null) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		flush();
	}, FLUSH_INTERVAL_MS);
}

function pushEntry(level: LogLevel, args: unknown[]): void {
	const message = args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(" ");
	const repeatKey = `${level}:${message}`;
	const repeatedEntryCount = repeatedEntryCounts.get(repeatKey) ?? 0;
	if (repeatedEntryCount >= MAX_REPEATED_ENTRIES) return;
	repeatedEntryCounts.set(repeatKey, repeatedEntryCount + 1);

	buffer.push({
		level,
		message,
		timestamp: new Date().toISOString(),
	});

	if (buffer.length >= MAX_BUFFER_SIZE) {
		flush();
	} else {
		scheduleFlush();
	}
}

export function installBrowserLogForwarder(): void {
	if (installed) return;
	if (typeof window === "undefined") return;

	installed = true;

	const levels: LogLevel[] = ["log", "error", "warn", "info", "debug"];

	for (const level of levels) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			original(...args);
			pushEntry(level, args);
		};
	}

	window.addEventListener("beforeunload", () => flush());
}
