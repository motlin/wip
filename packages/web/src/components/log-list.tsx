import {useVirtualizer} from "@tanstack/react-virtual";
import {useEffect, type ReactNode, type RefObject} from "react";
import type {LogEntry} from "@wip/shared";
import {scrollToBottom} from "../lib/use-auto-tail.js";
import {CATEGORY_CLASS, formatTime, LEVEL_CLASS, LEVEL_LABEL} from "../lib/log-format.js";

export interface KeyedEntry {
	id: number;
	entry: LogEntry;
}

const ESTIMATED_ROW_HEIGHT = 24;

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
