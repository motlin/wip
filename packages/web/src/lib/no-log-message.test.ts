import {describe, it, expect} from "vite-plus/test";

import {noLogMessage} from "./no-log-message";

describe("noLogMessage", () => {
	it("explains why a log is missing and how to get one", () => {
		expect(noLogMessage()).toBe(
			"No log is stored for this commit. Tests have not written one since the server started, or the log was cleared. Rerun the test to generate a log.",
		);
	});
});
