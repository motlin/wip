import type {PowerSource} from "@wip/shared";

export interface PowerWatchDeps {
	/** The current power source; production asks `pmset -g batt`, tests inject it. */
	read: () => Promise<PowerSource>;
	/** Called once per change, with whether the machine now runs on battery. */
	onChange: (onBattery: boolean) => void;
}

export interface PowerWatch {
	/** Read the power source now, calling onChange when it differs from the last reading. */
	check(): Promise<void>;
	/** The last reading; AC (false) until the first check says otherwise. */
	onBattery(): boolean;
}

/** Tracks AC vs battery power for the background-work pause; the caller decides how often to check. */
export function createPowerWatch(deps: PowerWatchDeps): PowerWatch {
	let battery = false;
	return {
		check: async () => {
			const next = (await deps.read()) === "battery";
			if (next === battery) return;
			battery = next;
			deps.onChange(battery);
		},
		onBattery: () => battery,
	};
}
