export type LogCategory = "subprocess" | "progress" | "general";

export interface LogEntry {
	time: number;
	level: number;
	category: string;
	msg: string;
	[key: string]: unknown;
}

type LogListener = (entry: LogEntry) => void;

const BUFFER_MAX = 2000;
const buffer: LogEntry[] = [];
const listeners = new Set<LogListener>();

const TOKEN_PATTERNS: RegExp[] = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g];
// user:password (or user:token) credentials embedded in a URL, e.g. https://user:token@github.com/
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** Replaces GitHub tokens and URL credentials in a string. */
export function scrubString(value: string): string {
	let out = value.replace(URL_CREDENTIALS, "$1[REDACTED]@");
	for (const pattern of TOKEN_PATTERNS) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

/** Applies scrubString to every string, recursing into arrays and objects. */
export function scrubSensitive(value: unknown): unknown {
	if (typeof value === "string") {
		return scrubString(value);
	}
	if (Array.isArray(value)) {
		return value.map((v) => scrubSensitive(v));
	}
	if (value instanceof Error) {
		// Own enumerable entries alone would drop message and stack; keep the
		// prototype so pino's err serializer still reports the error's type.
		const out: Record<string, unknown> = {};
		for (const [k, v] of [...Object.entries(value), ["message", value.message], ["stack", value.stack]]) {
			out[String(k)] = scrubSensitive(v);
		}
		Reflect.setPrototypeOf(out, Reflect.getPrototypeOf(value));
		return out;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = scrubSensitive(v);
		}
		return out;
	}
	return value;
}

export function writeLogEntry(entry: LogEntry): void {
	const scrubbed: LogEntry = {...entry};
	for (const [k, v] of Object.entries(entry)) {
		scrubbed[k] = scrubSensitive(v);
	}
	buffer.push(scrubbed);
	while (buffer.length > BUFFER_MAX) {
		buffer.shift();
	}
	for (const listener of listeners) {
		try {
			listener(scrubbed);
		} catch {
			// a failing listener must not break logging
		}
	}
}

export function getRecentLogs(): LogEntry[] {
	return buffer.slice();
}

export function subscribeLogs(listener: LogListener): void {
	listeners.add(listener);
}

export function unsubscribeLogs(listener: LogListener): void {
	listeners.delete(listener);
}

export function clearLogBuffer(): void {
	buffer.length = 0;
	listeners.clear();
}

export async function captureLogs<T>(
	fn: () => Promise<T> | T,
	options?: {categories?: readonly LogCategory[]},
): Promise<{result: T; logs: LogEntry[]}> {
	const captured: LogEntry[] = [];
	const filter = options?.categories ? new Set<string>(options.categories) : null;
	const listener: LogListener = (entry) => {
		if (filter && !filter.has(entry.category)) return;
		captured.push(entry);
	};
	subscribeLogs(listener);
	try {
		const result = await fn();
		return {result, logs: captured};
	} finally {
		unsubscribeLogs(listener);
	}
}
