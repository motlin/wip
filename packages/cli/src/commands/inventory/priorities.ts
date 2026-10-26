import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {Command, Flags} from "@oclif/core";
import {execa} from "execa";

import {
	type LadderNode,
	loadInventory,
	parseAsapLadder,
	type PriorityProposal,
	proposePriorities,
	saveInventory,
} from "@wip/shared";

export interface InventoryPrioritiesResult {
	proposals: PriorityProposal[];
	/** Repos whose registry priority this run wrote. */
	written: string[];
}

const DEFAULT_WORKFLOWY_CLI = path.join(os.homedir(), "projects", "workflowy", "bin", "run.js");

async function readBucket(cli: string, bucketId: string): Promise<unknown> {
	const {stdout} = await execa(cli, [
		"node",
		"get",
		"--id",
		bucketId,
		"--depth",
		"4",
		"--json",
		"--fields",
		"name,id,children,completedAt",
	]);
	return JSON.parse(stdout);
}

/**
 * Proposes a registry priority per repo from the GTD asap ladder: the highest tier a repo appears
 * in sets it (1st-2nd high, 3rd-4th medium, lower low). Writes only what the user confirms.
 */
export default class InventoryPriorities extends Command {
	static override description = "Propose registry priorities from the GTD asap ladder; write only confirmed ones";

	static enableJsonFlag = true;

	static override examples = [
		"<%= config.bin %> inventory priorities --bucket <asap-bucket-uuid>",
		"<%= config.bin %> inventory priorities --ladder ladder-work.json --ladder ladder-personal.json",
		"<%= config.bin %> inventory priorities --bucket <uuid> --accept wip --accept liftwizard",
		"<%= config.bin %> inventory priorities --bucket <uuid> --yes",
	];

	static override flags = {
		ladder: Flags.string({
			multiple: true,
			description: "A `node get --json` export of a 📌 Tasks (asap) bucket",
		}),
		bucket: Flags.string({
			multiple: true,
			description: "A 📌 Tasks (asap) bucket id to read through the workflowy CLI",
		}),
		"workflowy-cli": Flags.string({
			default: DEFAULT_WORKFLOWY_CLI,
			description: "The workflowy CLI used to read --bucket",
		}),
		accept: Flags.string({
			multiple: true,
			description: "Write the proposal for this repo (repeatable)",
		}),
		yes: Flags.boolean({
			char: "y",
			default: false,
			description: "Write every proposal",
		}),
	};

	async run(): Promise<InventoryPrioritiesResult> {
		const {flags} = await this.parse(InventoryPriorities);
		const ladderFiles = flags.ladder ?? [];
		const buckets = flags.bucket ?? [];
		if (ladderFiles.length === 0 && buckets.length === 0) this.error("Pass --ladder <file> or --bucket <id>");

		const ladders: LadderNode[] = [
			...ladderFiles.map((file) => parseAsapLadder(JSON.parse(fs.readFileSync(file, "utf-8")))),
			...(await Promise.all(
				buckets.map(async (id) => parseAsapLadder(await readBucket(flags["workflowy-cli"], id))),
			)),
		];
		const {projects, errors} = loadInventory();
		const proposals = proposePriorities(ladders, projects);

		const proposed = new Map(proposals.map((proposal) => [proposal.name, proposal.proposed]));
		const accepted = flags.yes ? [...proposed.keys()] : [...new Set(flags.accept ?? [])];
		const missing = accepted.filter((name) => !proposed.has(name));
		if (missing.length > 0) this.error(`There is no proposal for ${missing.join(", ")}`);

		for (const proposal of proposals) {
			const mark = accepted.includes(proposal.name) ? "*" : " ";
			this.log(
				`${mark} ${proposal.name}: ${proposal.current ?? "(unset)"} -> ${proposal.proposed}  (${proposal.ladder} tier ${proposal.tier}: ${proposal.evidence})`,
			);
		}

		if (accepted.length === 0) {
			if (proposals.length > 0) this.log("Nothing written; confirm with --accept <repo> or --yes");
			return {proposals, written: []};
		}
		// Saving rewrites the whole registry, which would drop the entries that failed to parse.
		if (errors.length > 0)
			this.error("The registry has invalid entries; fix them (wip inventory check) before writing");
		const acceptedSet = new Set(accepted);
		for (const project of projects) {
			const priority = acceptedSet.has(project.name) ? proposed.get(project.name) : undefined;
			if (priority) project.priority = priority;
		}
		saveInventory(projects);
		const written = proposals.filter((proposal) => acceptedSet.has(proposal.name)).map((proposal) => proposal.name);
		this.log(`Wrote ${written.length} priorities`);
		return {proposals, written};
	}
}
