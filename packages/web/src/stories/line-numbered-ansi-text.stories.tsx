import type { Meta, StoryObj } from "@storybook/react-vite";
import { LineNumberedAnsiText } from "../components/line-numbered-ansi-text.js";

const meta: Meta<typeof LineNumberedAnsiText> = {
  title: "Components/LineNumberedAnsiText",
  component: LineNumberedAnsiText,
};

export default meta;
type Story = StoryObj<typeof LineNumberedAnsiText>;

export const HappyPath: Story = {
  args: {
    text: [
      "$ vitest run --reporter=verbose",
      "",
      " RUN  v3.1.1 /Users/dev/projects/wip",
      "",
      " ✓ src/db.test.ts (12 tests) 3142ms",
      "   ✓ initDb creates tables",
      "   ✓ insertProject stores project",
      "   ✓ getProjects returns all",
      "   ✓ upsertChild inserts new row",
      "   ✓ upsertChild updates existing",
      "",
      " Test Files  1 passed (1)",
      " Tests  6 passed (6)",
      " Duration  3.8s",
    ].join("\n"),
    className: "p-4 font-mono text-xs leading-relaxed",
  },
};

export const WithAnsiColors: Story = {
  args: {
    text: [
      "\x1b[1m RUN \x1b[0m v3.1.1 /Users/dev/projects/wip",
      "",
      "\x1b[1m\x1b[32m ✓\x1b[0m src/db.test.ts (12 tests) \x1b[32m3.1s\x1b[0m",
      "\x1b[1m\x1b[31m ✗\x1b[0m src/git.test.ts (3 tests) \x1b[31m1.4s\x1b[0m",
      "   \x1b[31m× getChildren returns sorted branches\x1b[0m",
      "   \x1b[31m× isDirty detects staged changes\x1b[0m",
      "   \x1b[33m○ isDetachedHead skipped\x1b[0m",
      "",
      "\x1b[1mTest Files:\x1b[0m  \x1b[31m1 failed\x1b[0m | \x1b[32m1 passed\x1b[0m (2)",
      "\x1b[1mTests:\x1b[0m       \x1b[31m2 failed\x1b[0m | \x1b[33m1 skipped\x1b[0m | \x1b[32m12 passed\x1b[0m (15)",
    ].join("\n"),
    className: "p-4 font-mono text-xs leading-relaxed",
  },
};

export const SingleLine: Story = {
  args: {
    text: "✓ All tests passed",
    className: "p-4 font-mono text-xs leading-relaxed",
  },
};
