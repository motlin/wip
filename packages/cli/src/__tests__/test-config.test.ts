import {describe, expect, it} from "vite-plus/test";
import {loadTestConfig} from "./test-config.js";

describe("loadTestConfig", () => {
	it("loads the CLI config without emitting process warnings", async () => {
		const warnings: string[] = [];
		const onWarning = (warning: Error): void => {
			warnings.push(warning.message);
		};
		process.on("warning", onWarning);
		try {
			const config = await loadTestConfig();
			// process.emitWarning dispatches on the next tick.
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
			expect({name: config.name, bin: config.bin, warnings}).toStrictEqual({
				name: "@wip/cli",
				bin: "wip",
				warnings: [],
			});
		} finally {
			process.off("warning", onWarning);
		}
	});
});
