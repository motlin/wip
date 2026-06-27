import {Command, Flags} from "@oclif/core";

import {createSystemProbe} from "@wip/shared";

interface AdmitVerdict {
	loadPerCore: number;
	freeMemRatio: number;
	loadThreshold: number;
	memFloor: number;
	ok: boolean;
}

/**
 * Live resource verdict the advance skill consults before spawning another wave
 * of branch workers: report current CPU load and free-memory ratio against the
 * thresholds and whether it is safe to add more concurrency right now.
 */
export default class AdvanceAdmitCommand extends Command {
	static override description = "Report whether machine load/memory allow spawning more advance workers";

	static enableJsonFlag = true;

	static override examples = ["<%= config.bin %> advance admit --json"];

	static override flags = {
		"load-threshold": Flags.string({description: "Max 1-min load average per core", default: "1"}),
		"mem-floor": Flags.string({description: "Min free-memory ratio (0..1)", default: "0.1"}),
	};

	async run(): Promise<AdmitVerdict> {
		const {flags} = await this.parse(AdvanceAdmitCommand);
		const loadThreshold = Number.parseFloat(flags["load-threshold"]);
		const memFloor = Number.parseFloat(flags["mem-floor"]);
		const probe = createSystemProbe();
		const loadPerCore = probe.loadPerCore();
		const freeMemRatio = probe.freeMemRatio();
		const ok = loadPerCore < loadThreshold && freeMemRatio > memFloor;

		this.log(
			`load/core ${loadPerCore.toFixed(2)} (< ${loadThreshold}), free mem ${(freeMemRatio * 100).toFixed(0)}% (> ${(memFloor * 100).toFixed(0)}%) => ${ok ? "admit" : "hold"}`,
		);
		return {loadPerCore, freeMemRatio, loadThreshold, memFloor, ok};
	}
}
