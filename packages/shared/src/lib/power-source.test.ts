import {describe, expect, it, vi} from "vite-plus/test";

import {parsePmsetBatt, readPowerSource} from "./power-source.js";

// Captured from `pmset -g batt` on a MacBook.
const ON_AC =
	"Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
const ON_BATTERY =
	"Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:12 remaining present: true\n";

describe("parsePmsetBatt", () => {
	it("reads AC power, battery power, and nothing it recognizes", () => {
		expect({
			ac: parsePmsetBatt(ON_AC),
			battery: parsePmsetBatt(ON_BATTERY),
			desktop: parsePmsetBatt("Now drawing from 'AC Power'\n"),
			junk: parsePmsetBatt("pmset: command not found"),
		}).toStrictEqual({ac: "ac", battery: "battery", desktop: "ac", junk: null});
	});
});

describe("readPowerSource", () => {
	it("asks pmset on macOS, and treats other platforms and unreadable output as AC power", async () => {
		const pmset = vi.fn<() => Promise<string>>();
		pmset.mockResolvedValueOnce(ON_BATTERY).mockResolvedValueOnce("garbage").mockRejectedValueOnce(new Error("no"));
		expect({
			battery: await readPowerSource({platform: "darwin", pmset}),
			garbage: await readPowerSource({platform: "darwin", pmset}),
			failed: await readPowerSource({platform: "darwin", pmset}),
			linux: await readPowerSource({platform: "linux", pmset}),
			calls: pmset.mock.calls.length,
		}).toStrictEqual({battery: "battery", garbage: "ac", failed: "ac", linux: "ac", calls: 3});
	});
});
