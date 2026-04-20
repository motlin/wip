import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..");

/**
 * Files that import node: builtins with named imports (e.g.
 * `import { EventEmitter } from "node:events"`) resolve the binding at
 * module load time. Vite externalizes node: modules for the browser, so
 * the proxy throws on property access — breaking React hydration entirely.
 *
 * These files must only be referenced via dynamic `await import()`, never
 * via static import statements, so they stay out of the client bundle.
 */

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\./.test(entry.name) &&
      !/\.d\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("client bundle has no node: imports", () => {
  it("files with named node: imports are only dynamically imported", () => {
    const allFiles = collectFiles(SRC_DIR);
    const fileContents = new Map(
      allFiles.map((file) => [file, fs.readFileSync(file, "utf-8")] as const),
    );

    const nodeFiles = new Set<string>();
    for (const [file, content] of fileContents) {
      if (/^\s*import\s+\{[^}]+\}\s+from\s+["']node:/m.test(content)) {
        nodeFiles.add(file);
      }
    }

    const violations: string[] = [];
    for (const [file, content] of fileContents) {
      const dir = path.dirname(file);

      const staticImportRe =
        /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?\s+from\s+["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = staticImportRe.exec(content)) !== null) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        const resolved = path.resolve(dir, specifier).replace(/\.js$/, "");

        for (const nodeFile of nodeFiles) {
          const nodeBase = nodeFile.replace(/\.tsx?$/, "");
          if (resolved === nodeBase) {
            const rel = path.relative(SRC_DIR, file);
            const nodeRel = path.relative(SRC_DIR, nodeFile);
            violations.push(`${rel} statically imports ${nodeRel}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Files with named node: imports must only be dynamically imported ` +
          `(await import()) to stay out of the client bundle:\n  ${violations.join("\n  ")}`,
      );
    }
  });
});
