import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {saveInventory, type ProjectRecord} from "@wip/shared";

/**
 * Points XDG_CONFIG_HOME at a fresh temp directory so tests never read or write the real
 * ~/.config/wip. Pass projects to also save a registry there. Returns a restore function.
 */
export function useTempConfigHome(projects?: ProjectRecord[]): {dir: string; restore: () => void} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wip-config-"));
	const original = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(dir, "config");
	if (projects) saveInventory(projects);
	return {
		dir,
		restore: () => {
			if (original === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = original;
			fs.rmSync(dir, {recursive: true, force: true});
		},
	};
}
