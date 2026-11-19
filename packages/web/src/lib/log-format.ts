/** How a log entry's time, level and category look, on the live logs page and an action's own log. */

export const LEVEL_LABEL: Record<number, string> =
{
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

export const LEVEL_CLASS: Record<number, string> =
{
	10: "text-text-500",
	20: "text-text-400",
	30: "text-text-100",
	40: "text-yellow-700 dark:text-yellow-400",
	50: "text-red-600 dark:text-red-400",
	60: "text-red-700 dark:text-red-300 font-semibold",
};

export const CATEGORY_CLASS: Record<string, string> =
{
	subprocess: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
	progress: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
	general: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export function formatTime(time: number): string
{
	const d = new Date(time);
	const hh = d.getHours().toString().padStart(2, "0");
	const mm = d.getMinutes().toString().padStart(2, "0");
	const ss = d.getSeconds().toString().padStart(2, "0");
	const ms = d.getMilliseconds().toString().padStart(3, "0");
	return `${hh}:${mm}:${ss}.${ms}`;
}
