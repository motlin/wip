import {createFileRoute} from "@tanstack/react-router";
import {useEffect, useMemo, useRef, useState} from "react";
import {z} from "zod";
import {LogList, type KeyedEntry} from "../components/log-list.js";
import {useAutoTail} from "../lib/use-auto-tail.js";

export const Route = createFileRoute("/debug/logs")({
	head: () => ({
		meta: [{title: "Server Logs"}],
	}),
	component: DebugLogs,
});

const LevelFilterSchema = z.enum(["all", "debug", "info", "warn", "error"]);
type LevelFilter = z.infer<typeof LevelFilterSchema>;
const CategoryFilterSchema = z.enum(["all", "subprocess", "progress", "general"]);
type CategoryFilter = z.infer<typeof CategoryFilterSchema>;

const ServerLogStatusSchema = z.object({loggingEnabled: z.boolean()});
const LogEntrySchema = z.looseObject({
	time: z.number(),
	level: z.number(),
	category: z.string(),
	msg: z.string(),
});

const LEVEL_MIN: Record<LevelFilter, number> = {
	all: 0,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
};

function DebugLogs() {
	const [entries, setEntries] = useState<KeyedEntry[]>([]);
	const nextId = useRef(0);
	const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
	const [search, setSearch] = useState("");
	const [connected, setConnected] = useState(false);
	const [loggingEnabled, setLoggingEnabled] = useState<boolean | null>(null);

	useEffect(() => {
		const es = new EventSource("/api/server-logs");
		es.addEventListener("open", () => {
			setConnected(true);
		});
		es.addEventListener("error", () => {
			setConnected(false);
		});
		const handleStatus = (event: MessageEvent<string>) => {
			const status = ServerLogStatusSchema.safeParse(JSON.parse(event.data));
			if (!status.success) return;
			setLoggingEnabled(status.data.loggingEnabled);
			setConnected(true);
		};
		es.addEventListener("status", handleStatus);
		es.addEventListener("message", (event: MessageEvent<string>) => {
			const parsed = LogEntrySchema.safeParse(JSON.parse(event.data));
			if (!parsed.success) return;
			const keyed: KeyedEntry = {id: nextId.current++, entry: parsed.data};
			setEntries((prev) => {
				const next = [...prev, keyed];
				return next.length > 2000 ? next.slice(-2000) : next;
			});
		});
		return () => {
			es.removeEventListener("status", handleStatus);
			es.close();
		};
	}, []);

	const filtered = useMemo(() => {
		const minLevel = LEVEL_MIN[levelFilter];
		const needle = search.trim().toLowerCase();
		return entries.filter(({entry}) => {
			if (entry.level < minLevel) return false;
			if (categoryFilter !== "all" && entry.category !== categoryFilter) return false;
			if (needle && !entry.msg.toLowerCase().includes(needle)) return false;
			return true;
		});
	}, [entries, levelFilter, categoryFilter, search]);

	const {containerRef, isFollowing, setFollowing, handleScroll} = useAutoTail(String(filtered.length));

	const clear = () => {
		setEntries([]);
	};

	const emptyMessage =
		entries.length > 0
			? "No entries match the current filters."
			: connected
				? loggingEnabled === false
					? "Waiting for log entries. Set WIP_SUBPROCESS_LOGGING=true to enable the logger."
					: "Waiting for log entries. Server logging is enabled."
				: "Connecting to server log stream...";

	return (
		<div className="flex h-[calc(100vh-2.5rem)] flex-col">
			<div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border-300/30 bg-bg-100 px-4 py-2 text-xs">
				<span className="font-semibold text-text-200">Server Logs</span>
				<span
					className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono ${
						connected
							? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
							: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
					}`}
				>
					<span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
					{connected ? "live" : "offline"}
				</span>
				<span className="text-text-500">{filtered.length} entries</span>
				<label className="ml-2 flex items-center gap-1">
					<span className="text-text-400">Level:</span>
					<select
						value={levelFilter}
						onChange={(e) => {
							const parsed = LevelFilterSchema.safeParse(e.target.value);
							if (parsed.success) setLevelFilter(parsed.data);
						}}
						className="rounded border border-border-300/50 bg-bg-000 px-1.5 py-0.5 text-xs text-text-100"
					>
						<option value="all">all</option>
						<option value="debug">debug+</option>
						<option value="info">info+</option>
						<option value="warn">warn+</option>
						<option value="error">error+</option>
					</select>
				</label>
				<label className="flex items-center gap-1">
					<span className="text-text-400">Category:</span>
					<select
						value={categoryFilter}
						onChange={(e) => {
							const parsed = CategoryFilterSchema.safeParse(e.target.value);
							if (parsed.success) setCategoryFilter(parsed.data);
						}}
						className="rounded border border-border-300/50 bg-bg-000 px-1.5 py-0.5 text-xs text-text-100"
					>
						<option value="all">all</option>
						<option value="subprocess">subprocess</option>
						<option value="progress">progress</option>
						<option value="general">general</option>
					</select>
				</label>
				<input
					value={search}
					onChange={(e) => {
						setSearch(e.target.value);
					}}
					placeholder="Search message..."
					className="rounded border border-border-300/50 bg-bg-000 px-2 py-0.5 text-xs text-text-100 placeholder:text-text-500"
				/>
				<button
					type="button"
					onClick={clear}
					className="ml-auto rounded border border-border-300/50 bg-bg-000 px-2 py-0.5 text-xs text-text-300 hover:bg-bg-200 hover:text-text-100"
				>
					Clear
				</button>
				<button
					type="button"
					onClick={() => {
						setFollowing(!isFollowing);
					}}
					className={`rounded border px-2 py-0.5 text-xs ${
						isFollowing
							? "border-green-500/50 bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
							: "border-border-300/50 bg-bg-000 text-text-300 hover:bg-bg-200 hover:text-text-100"
					}`}
				>
					{isFollowing ? "Following" : "Paused"}
				</button>
			</div>
			<LogList entries={filtered} containerRef={containerRef} onScroll={handleScroll} isFollowing={isFollowing}>
				{filtered.length === 0 && <p className="p-4 text-sm text-text-500">{emptyMessage}</p>}
			</LogList>
		</div>
	);
}
