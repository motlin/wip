/**
 * Whether the Mac runs on AC or battery power, from `pmset -g batt`. Background work (the ready
 * buffer, Push main pre-testing) pauses on battery; user-initiated actions never ask. No node
 * builtins: the caller injects how pmset runs.
 */

export type PowerSource = "ac" | "battery";

/** The power source `pmset -g batt` names on its first line ("Now drawing from 'AC Power'"); null when unrecognized. */
export function parsePmsetBatt(stdout: string): PowerSource | null
{
	const drawing = /Now drawing from '([^']+)'/.exec(stdout)?.[1];
	if (drawing === "AC Power") return "ac";
	if (drawing === "Battery Power") return "battery";
	return null;
}

export interface PowerSourceReader
{
	platform: string;
	/** Runs `pmset -g batt` and resolves to its stdout. */
	pmset: () => Promise<string>;
}

/** The current power source. Only macOS is asked; elsewhere, and whenever pmset fails or is unreadable, AC. */
export async function readPowerSource(reader: PowerSourceReader): Promise<PowerSource>
{
	if (reader.platform !== "darwin") return "ac";
	try
	{
		return parsePmsetBatt(await reader.pmset()) ?? "ac";
	}
	catch
	{
		return "ac";
	}
}
