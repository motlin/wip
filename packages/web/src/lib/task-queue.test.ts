import { describe, it, expect } from "vite-plus/test";
import { statusToTransition } from "./task-queue";
import type { TaskStatus } from "./task-queue";

describe("statusToTransition", () => {
  it("maps queued to run_test for test tasks", () => {
    expect(statusToTransition("queued", "test")).toBe("run_test");
  });

  it("maps running to run_test for test tasks", () => {
    expect(statusToTransition("running", "test")).toBe("run_test");
  });

  it("maps passed to test_pass for test tasks", () => {
    expect(statusToTransition("passed", "test")).toBe("test_pass");
  });

  it("maps failed to test_fail for test tasks", () => {
    expect(statusToTransition("failed", "test")).toBe("test_fail");
  });

  it("maps cancelled to cancel_test for test tasks", () => {
    expect(statusToTransition("cancelled", "test")).toBe("cancel_test");
  });

  it("covers all TaskStatus values for test tasks", () => {
    const allStatuses: TaskStatus[] = ["queued", "running", "passed", "failed", "cancelled"];
    for (const status of allStatuses) {
      expect(statusToTransition(status, "test")).toBeDefined();
    }
  });

  it("returns undefined for non-test task types", () => {
    const allStatuses: TaskStatus[] = ["queued", "running", "passed", "failed", "cancelled"];
    for (const status of allStatuses) {
      expect(statusToTransition(status, "claude")).toBeUndefined();
      expect(statusToTransition(status, "rebase")).toBeUndefined();
    }
  });

  it("defaults to test task type when not specified", () => {
    expect(statusToTransition("passed")).toBe("test_pass");
  });
});
