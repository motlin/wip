import {describe, it, expect} from "vite-plus/test";

import {tracedExeca} from "./traced-execa.js";

describe("tracedExeca exit codes", () => {
	it("reports 0 for a successful command", async () => {
		const result = await tracedExeca("true", [], {reject: false});
		expect(result.exitCode).toBe(0);
		expect(result.failed).toBe(false);
	});

	it("reports the real non-zero exit code", async () => {
		const result = await tracedExeca("sh", ["-c", "exit 3"], {reject: false});
		expect(result.exitCode).toBe(3);
		expect(result.failed).toBe(true);
	});

	it("reports non-zero for a timed-out process", async () => {
		const result = await tracedExeca("sleep", ["5"], {reject: false, timeout: 50});
		expect(result.exitCode).not.toBe(0);
		expect(result.failed).toBe(true);
	});

	it("reports non-zero for a cancelled process", async () => {
		const controller = new AbortController();
		const promise = tracedExeca("sleep", ["5"], {reject: false, cancelSignal: controller.signal});
		setTimeout(() => {
			controller.abort();
		}, 50);
		const result = await promise;
		expect(result.exitCode).not.toBe(0);
		expect(result.failed).toBe(true);
	});
});
