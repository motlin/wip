import { describe, it, expect } from "vite-plus/test";

import {
  GitHubProjectItemSchema,
  GitHubProjectItemLabelSchema,
  GitHubProjectSchema,
} from "./github-projects.js";

describe("GitHubProjectItemLabelSchema", () => {
  it("accepts a valid label", () => {
    const label = { name: "enhancement", color: "a2eeef" };
    expect(GitHubProjectItemLabelSchema.parse(label)).toStrictEqual(label);
  });

  it("rejects an empty name", () => {
    expect(() => GitHubProjectItemLabelSchema.parse({ name: "", color: "a2eeef" })).toThrow();
  });

  it("rejects an invalid color", () => {
    expect(() => GitHubProjectItemLabelSchema.parse({ name: "bug", color: "xyz" })).toThrow();
  });
});

describe("GitHubProjectSchema", () => {
  it("accepts a valid project", () => {
    const project = { number: 1, title: "My Project" };
    expect(GitHubProjectSchema.parse(project)).toStrictEqual(project);
  });

  it("rejects a non-positive number", () => {
    expect(() => GitHubProjectSchema.parse({ number: 0, title: "X" })).toThrow();
  });

  it("rejects a non-integer number", () => {
    expect(() => GitHubProjectSchema.parse({ number: 1.5, title: "X" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => GitHubProjectSchema.parse({ number: 1, title: "" })).toThrow();
  });
});

describe("GitHubProjectItemSchema", () => {
  const validItem = {
    id: "PVTI_abc123",
    title: "Fix the thing",
    status: "In Progress",
    type: "ISSUE" as const,
    url: "https://github.com/owner/repo/issues/42",
    number: 42,
    repository: "owner/repo",
    labels: [{ name: "bug", color: "d73a4a" }],
  };

  it("accepts a valid project item", () => {
    expect(GitHubProjectItemSchema.parse(validItem)).toStrictEqual(validItem);
  });

  it("accepts a draft issue without url, number, or repository", () => {
    const draft = {
      id: "PVTI_draft",
      title: "Draft idea",
      status: "Todo",
      type: "DRAFT_ISSUE" as const,
      labels: [],
    };
    expect(GitHubProjectItemSchema.parse(draft)).toStrictEqual(draft);
  });

  it("rejects an invalid type", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, type: "UNKNOWN" })).toThrow();
  });

  it("rejects an empty id", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, id: "" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, title: "" })).toThrow();
  });

  it("rejects a non-positive number", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, number: 0 })).toThrow();
  });

  it("rejects a non-integer number", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, number: 1.5 })).toThrow();
  });

  it("rejects an invalid url", () => {
    expect(() => GitHubProjectItemSchema.parse({ ...validItem, url: "not-a-url" })).toThrow();
  });

  it("accepts a PULL_REQUEST type", () => {
    const pr = { ...validItem, type: "PULL_REQUEST" as const };
    expect(GitHubProjectItemSchema.parse(pr)).toStrictEqual(pr);
  });
});
