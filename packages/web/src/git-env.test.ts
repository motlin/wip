import {describe, it, expect} from "vite-plus/test";

describe("test worker environment", () => {
	it("carries no GIT_* variable that could point child git processes at another repo", () => {
		const gitVariables = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => key.startsWith("GIT_") && key !== "GIT_FIXTURE_RECORD"),
		);
		expect(gitVariables).toStrictEqual({
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
	});
});
