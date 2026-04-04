import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi, type Mock } from "vite-plus/test";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "..", "__fixtures__", "git");

const isRecordMode = process.env["GIT_FIXTURE_RECORD"] === "true";

export interface RecordedCall {
  command: string;
  args: string[];
  input?: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface FixtureFile {
  calls: RecordedCall[];
}

function hashCall(command: string, args: string[], input?: string): string {
  const payload = JSON.stringify({ command, args, input: input ?? "" });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function getFixtureDir(testName: string): string {
  return join(fixturesDir, testName);
}

function getFixturePath(testName: string, command: string, args: string[], input?: string): string {
  const hash = hashCall(command, args, input);
  return join(getFixtureDir(testName), `${hash}.json`);
}

function saveFixture(fixturePath: string, call: RecordedCall): void {
  const dir = dirname(fixturePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data: FixtureFile = { calls: [call] };
  writeFileSync(fixturePath, JSON.stringify(data, null, 2) + "\n");
}

export interface GitFixtureContext {
  mock: Mock;
  addFixture: (call: RecordedCall) => void;
  stop: () => void;
}

/**
 * Set up git subprocess fixture recording/replay for a test.
 *
 * In replay mode (default), intercepts tracedExeca calls and returns
 * recorded fixture data. Throws if no fixture is found.
 *
 * In record mode (GIT_FIXTURE_RECORD=true), calls the real tracedExeca
 * and saves the results as fixture files.
 *
 * @param testName - Unique name for this test's fixtures (used as directory name)
 */
export function setupGitFixtures(testName: string): GitFixtureContext {
  const fixtureMap = new Map<string, RecordedCall>();

  // Pre-load all existing fixtures for this test
  const testDir = getFixtureDir(testName);
  if (existsSync(testDir)) {
    for (const file of readdirSync(testDir)) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(testDir, file);
      const content = readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as FixtureFile;
      const call = data.calls[0];
      if (call) {
        const hash = hashCall(call.command, call.args, call.input);
        fixtureMap.set(hash, call);
      }
    }
  }

  const mockFn = vi.fn(
    async (
      command: string,
      args: string[],
      options?: { input?: string; reject?: boolean; env?: Record<string, string>; cwd?: string },
    ) => {
      const input = options?.input;
      const hash = hashCall(command, args, input);

      if (isRecordMode) {
        const { tracedExeca: realTracedExeca } = await import("../services/traced-execa.js");
        const result = await realTracedExeca(command, args, options);
        const recorded: RecordedCall = {
          command,
          args,
          ...(input ? { input } : {}),
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
        const fixturePath = getFixturePath(testName, command, args, input);
        saveFixture(fixturePath, recorded);
        fixtureMap.set(hash, recorded);
        return result;
      }

      // Replay mode: look up fixture by command+args hash
      const recorded = fixtureMap.get(hash);
      if (!recorded) {
        throw new Error(
          `No git fixture found for: ${command} ${args.join(" ")}\n` +
            `Hash: ${hash}\n` +
            `Run with GIT_FIXTURE_RECORD=true to record fixtures.`,
        );
      }

      return {
        stdout: recorded.stdout,
        stderr: recorded.stderr,
        exitCode: recorded.exitCode,
        failed: recorded.exitCode !== 0,
        command: `${command} ${args.join(" ")}`,
      };
    },
  );

  function addFixture(call: RecordedCall): void {
    const hash = hashCall(call.command, call.args, call.input);
    fixtureMap.set(hash, call);
    const fixturePath = getFixturePath(testName, call.command, call.args, call.input);
    saveFixture(fixturePath, call);
  }

  function stop(): void {
    mockFn.mockRestore();
  }

  return { mock: mockFn, addFixture, stop };
}
