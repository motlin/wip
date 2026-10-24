import {useState} from "react";
import type {InventoryStatus, RegistryCandidates, RegistrySummary, SaveRegistryInput} from "@wip/shared";
import {runPendingAction} from "../lib/pending-action.js";
import {CheckCircle, ClipboardList} from "./icons.js";
import {RegistryReview} from "./registry-review.js";

function formatCounts(counts: Record<string, number>): string {
	return Object.keys(counts)
		.toSorted()
		.map((key) => `${key} ${counts[key]}`)
		.join(", ");
}

const cardClass = "mb-3 rounded-lg border border-border-300/50 bg-bg-100 p-3 text-xs text-text-300";

function SummaryCard({inventory}: {inventory: InventoryStatus}) {
	const {registry, registryPath, templatesDir} = inventory;
	return (
		<section aria-label="Project registry" className={`${cardClass} ${registry ? "" : "border-status-yellow/50"}`}>
			<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-200">
				<ClipboardList className="h-4 w-4" />
				Project registry
			</h2>
			{registry ? (
				<>
					<p>
						{registry.total} projects in <code className="font-mono">{registryPath}</code>
					</p>
					<p>Kind: {formatCounts(registry.byKind)}</p>
					<p>
						Modified{" "}
						<time dateTime={registry.modifiedAt}>{new Date(registry.modifiedAt).toLocaleString()}</time>
					</p>
				</>
			) : (
				<p>
					No project registry at <code className="font-mono">{registryPath}</code>. Decide each repo below,
					from what the templates in <code className="font-mono">{templatesDir}</code> list plus the repos on
					disk, then import before running the ladder on every project.
				</p>
			)}
		</section>
	);
}

function SaveConfirmation({
	verb,
	registryPath,
	registry,
}: {
	verb: "Imported" | "Saved";
	registryPath: string;
	registry: RegistrySummary;
}) {
	return (
		<output
			aria-label="Registry saved"
			className="mb-3 block rounded-md border border-status-green/50 bg-bg-200 p-3 text-xs text-text-300"
		>
			<p className="flex items-center gap-1.5 font-medium text-text-100">
				<CheckCircle className="h-4 w-4 text-status-green" />
				{verb} {registry.total} projects into <code className="font-mono">{registryPath}</code>
			</p>
			<p>Kind: {formatCounts(registry.byKind)}</p>
			<p>Template: {formatCounts(registry.byTemplate)}</p>
		</output>
	);
}

/**
 * The project registry as its own cards on /tasks: a summary of the saved file (or an import
 * prompt before one exists), a confirmation right after a save from this page, and the review's
 * group cards. The review remounts with fresh rows whenever the registry the candidates came from
 * changes, so its pending save state lives here. Failures surface only as a toast.
 */
export function RegistrySection({
	inventory,
	candidates,
	saveRegistry,
}: {
	/** Registry status; undefined while loading. */
	inventory: InventoryStatus | undefined;
	/** Registry review rows; undefined while loading. */
	candidates: RegistryCandidates | undefined;
	/** Writes the reviewed registry and resolves to the new status. */
	saveRegistry: (input: SaveRegistryInput) => Promise<InventoryStatus>;
}) {
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState<{verb: "Imported" | "Saved"; registry: RegistrySummary} | null>(null);

	if (!inventory) return <p className="mb-6 text-xs text-text-500">Loading project registry…</p>;
	const {registryPath, registry} = inventory;
	const verb = inventory.exists ? "Saved" : "Imported";

	return (
		<div className="mb-6">
			<SummaryCard inventory={inventory} />
			{inventory.exists && saved && (
				<SaveConfirmation verb={saved.verb} registryPath={registryPath} registry={saved.registry} />
			)}
			{candidates ? (
				<RegistryReview
					key={candidates.baseModifiedAt ?? "none"}
					candidates={candidates.candidates}
					current={registry?.projects ?? []}
					saveLabel={(count) =>
						verb === "Saved"
							? `Save ${count} projects to ${registryPath}`
							: `Import ${count} projects into ${registryPath}`
					}
					saving={saving}
					onSave={(projects) => {
						void runPendingAction(verb === "Saved" ? "Save registry" : "Import", setSaving, async () => {
							const status = await saveRegistry({projects, baseModifiedAt: candidates.baseModifiedAt});
							if (status.registry) setSaved({verb, registry: status.registry});
						});
					}}
				/>
			) : (
				<p className="text-xs text-text-500">Loading registry candidates…</p>
			)}
		</div>
	);
}
