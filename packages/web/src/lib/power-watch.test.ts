import {describe, expect, it} from "vite-plus/test";

import {createPowerWatch} from "./power-watch.js";
import type {PowerSource} from "@wip/shared";

describe("createPowerWatch", () => {
	it("starts on AC, and reports each change of power source once", async () => {
		const sources: PowerSource[] = ["ac", "battery", "battery", "ac"];
		const changes: boolean[] = [];
		const watch = createPowerWatch({
			read: async () => Promise.resolve(sources.shift() ?? "ac"),
			onChange: (onBattery) => {
				changes.push(onBattery);
			},
		});
		const seen: boolean[] = [watch.onBattery()];
		for (let i = 0; i < 4; i++) {
			// eslint-disable-next-line no-await-in-loop -- each check reads the next power source in order
			await watch.check();
			seen.push(watch.onBattery());
		}
		expect({seen, changes}).toStrictEqual({seen: [false, false, true, true, false], changes: [true, false]});
	});
});
