import { describe, it, expect, afterEach } from "vite-plus/test";

import { setupPolly } from "./setup-polly.js";

describe("setupPolly", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = undefined;
    }
  });

  it("creates a Polly instance in replay mode by default", () => {
    const result = setupPolly({ name: "test-polly-setup" });
    stop = result.stop;

    expect(result.polly).toBeDefined();
    expect(result.polly.mode).toBe("replay");
    expect(typeof result.stop).toBe("function");
  });

  it("intercepts fetch and fails on unrecorded requests in replay mode", async () => {
    const result = setupPolly({ name: "test-unrecorded-request" });
    stop = result.stop;

    await expect(
      fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { login } }" }),
      }),
    ).rejects.toThrow();
  });
});
