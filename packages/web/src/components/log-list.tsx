import {useVirtualizer} from "@tanstack/react-virtual";
import {useEffect, type ReactNode, type RefObject} from "react";
import type {LogEntry} from "@wip/shared";
import {scrollToBottom} from "../lib/use-auto-tail";

export interface KeyedEntry {
	id: number;
	entry: LogEntry;
}

const LEVEL_LABEL: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

const LEVEL_CLASS: Record<number, string> = {
	10: "text-text-500",
	20: "text-text-400",
	30: "text-text-100",
	40: "text-yellow-700 dark:text-yellow-400",
	50: "text-red-600 dark:text-red-400",
	60: "text-red-700 dark:text-red-300 font-semibold",
};

const CATEGORY_CLASS: Record<string, string> = {
	subprocess: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
	progress: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
	general: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const ESTIMATED_ROW_HEIGHT = 24;

function formatTime(time: number): string {
	const d = new Date(time);
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	const ss = d.getSeconds().toString().padStart(2, "0");
	const ms = d.getMilliseconds().toString().padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}

function extras(entry: LogEntry): Record<string, unknown> {
	const skip = new Set(["time", "level", "category", "msg", "pid", "hostname", "v"]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entry)) {
		if (!skip.has(k)) out[k] = v;
	}
	return out;
}

interface LogListProps {
	entries: KeyedEntry[];
	containerRef: RefObject<HTMLDivElement | null>;
	onScroll: () => void;
	isFollowing: boolean;
	children?: ReactNode;
}

/** Scrollable, virtualized list of log entries. Only visible rows are in the DOM. */
export function LogList({entries, containerRef, onScroll, isFollowing, children}: LogListProps) {
	// oxlint-disable-next-line react/incompatible-library -- the compiler skips this component, which is acceptable here
	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		getItemKey: (index) => entries[index]?.id ?? index,
		overscan: 10,
	});
	const totalSize = virtualizer.getTotalSize();

	// Row heights are measured lazily, so keep pinned to the bottom while following.
	useEffect(() => {
		if (!isFollowing) return;
		const el = containerRef.current;
		if (el) scrollToBottom(el);
	}, [totalSize, isFollowing, containerRef]);

	return (
		<div
			ref={containerRef}
			onScroll={onScroll}
			className="relative flex-1 overflow-auto bg-bg-000 font-mono text-xs scrollbar-thin"
		>
			{children}
			{entries.length > 0 && (
				<ul className="relative w-full" style={{height: totalSize}}>
					{virtualizer.getVirtualItems().map((item) => {
						const keyed = entries[item.index];
						if (!keyed) return null;
						const {entry} = keyed;
						const levelName = LEVEL_LABEL[entry.level] ?? String(entry.level);
						const levelCls = LEVEL_CLASS[entry.level] ?? "text-text-200";
						const catCls =
							CATEGORY_CLASS[entry.category] ??
							"bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
						const extra = extras(entry);
						const hasExtra = Object.keys(extra).length > 0;
						return (
							<li
								key={item.key}
								data-index={item.index}
								ref={virtualizer.measureElement}
								className="absolute left-0 top-0 flex w-full items-start gap-2 border-b border-border-300/20 px-4 py-1 hover:bg-bg-100"
								style={{transform: `translateY(${item.start}px)`}}
							>
								<span className="flex-shrink-0 text-text-500">{formatTime(entry.time)}</span>
								<span
									className={`flex-shrink-0 w-11 uppercase tracking-wide ${levelCls}`}
									title={levelName}
								>
									{levelName}
								</span>
								<span className={`flex-shrink-0 rounded px-1 py-0.5 text-[10px] uppercase ${catCls}`}>
									{entry.category}
								</span>
								<span className={`flex-1 whitespace-pre-wrap break-words ${levelCls}`}>
									{entry.msg}
									{hasExtra && <span className="ml-2 text-text-500">{JSON.stringify(extra)}</span>}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
