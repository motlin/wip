import {useState, type ReactNode} from "react";
import {Bot, CheckCircle, Copy, ExternalLink, GitMerge, Loader2, OctagonAlert} from "./icons.js";
import type {
	InventoryStatus,
	LadderResult,
	RegistryCandidateFlag,
	RegistryCandidates,
	RegistrySummary,
	SaveRegistryInput,
} from "@wip/shared";
import {runPendingAction} from "../lib/pending-action.js";
import {RegistryReview} from "./registry-review.js";

function formatCounts(counts: Record<string, number>): string {
	return Object.keys(counts)
		.toSorted()
		.map((key) => `${key} ${counts[key]}`)
		.join(", ");
}

function ImportStep({inventory, children}: {inventory: InventoryStatus; children: ReactNode}) {
	return (
		<section
			aria-label="Import project registry"
			className="mb-3 rounded-md border border-status-yellow/50 bg-bg-200 p-3 text-xs text-text-300"
		>
			<p className="mb-2">
				No project registry at <code className="font-mono">{inventory.registryPath}</code>. Review what the
				templates in <code className="font-mono">{inventory.templatesDir}</code> list plus the repos on disk,
				then import before running the ladder on every project.
			</p>
			{children}
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

function flagCount(candidates: RegistryCandidates, flag: RegistryCandidateFlag): number {
	return candidates.candidates.filter((candidate) => candidate.flags.includes(flag)).length;
}

function RegistryOverview({registryPath, registry}: {registryPath: string; registry: RegistrySummary}) {
	return (
		<section aria-label="Project registry" className="mb-3 text-xs text-text-400">
			<details>
				<summary className="cursor-pointer">
					{registry.total} projects in <code className="font-mono">{registryPath}</code>, modified{" "}
					<time dateTime={registry.modifiedAt}>{new Date(registry.modifiedAt).toLocaleString()}</time>
				</summary>
				<ul className="mt-1 ml-4 list-disc font-mono">
					{registry.projects.map((project) => (
						<li key={project.dir}>
							{project.name} ({project.template}, {project.kind})
						</li>
					))}
				</ul>
			</details>
		</section>
	);
}

/**
 * Ladder results per project with a button that queues the ladder for every project. Until a
 * project registry exists the button stays disabled and an import step takes its place, where the
 * user reviews every candidate and confirms the diff before importing, so one click can never fall
 * back to scanning every directory. Once it exists a compact summary shows what wip will act on,
 * with the same review available to correct it, preceded by a confirmation right after a save from
 * this page. The save's pending state lives here rather than in the review, which remounts on
 * success. Failures surface only as a toast via runPendingAction.
 */
export function LadderSection({
	inventory,
	candidates,
	saveRegistry,
	results,
	runLadderAll,
	focusPane,
}: {
	/** Registry status; undefined while loading. */
	inventory: InventoryStatus | undefined;
	/** Registry review rows; undefined while loading. */
	candidates: RegistryCandidates | undefined;
	/** Writes the reviewed registry and resolves to the new status. */
	saveRegistry: (input: SaveRegistryInput) => Promise<InventoryStatus>;
	results: readonly LadderResult[];
	runLadderAll: () => Promise<unknown>;
	focusPane: (paneId: string) => Promise<unknown>;
}) {
	const [running, setRunning] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState<{verb: "Imported" | "Saved"; registry: RegistrySummary} | null>(null);
	const registered = inventory?.exists === true;
	const registry = inventory?.registry ?? null;

	const review = (saveLabel: (count: number) => string) =>
		candidates ? (
			<RegistryReview
				// Remount with fresh rows whenever the registry the candidates came from changes.
				key={candidates.baseModifiedAt ?? "none"}
				candidates={candidates.candidates}
				current={registry?.projects ?? []}
				saveLabel={saveLabel}
				saving={saving}
				onSave={(projects) => {
					const verb = registered ? "Saved" : "Imported";
					void runPendingAction(verb === "Saved" ? "Save registry" : "Import", setSaving, async () => {
						const status = await saveRegistry({projects, baseModifiedAt: candidates.baseModifiedAt});
						if (status.registry) setSaved({verb, registry: status.registry});
					});
				}}
			/>
		) : (
			<p className="text-xs text-text-500">Loading registry candidates…</p>
		);

	return (
		<section className="mb-6 rounded-lg border border-border-300/50 bg-bg-100 p-4">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="flex items-center gap-2 text-sm font-semibold text-text-200">
					<GitMerge className="h-4 w-4" />
					Ladder
				</h2>
				<button
					type="button"
					disabled={running || !registered}
					onClick={() => {
						void runPendingAction("Run ladder", setRunning, runLadderAll);
					}}
					className="inline-flex items-center gap-1.5 rounded-md border border-border-300/50 px-2.5 py-1 text-xs font-medium text-text-200 transition-colors hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
					Run ladder
				</button>
			</div>
			{inventory && !inventory.exists && (
				<ImportStep inventory={inventory}>
					{review((count) => `Import ${count} projects into ${inventory.registryPath}`)}
				</ImportStep>
			)}
			{inventory && registered && saved && (
				<SaveConfirmation verb={saved.verb} registryPath={inventory.registryPath} registry={saved.registry} />
			)}
			{inventory && registry && <RegistryOverview registryPath={inventory.registryPath} registry={registry} />}
			{inventory && registered && (
				<details className="mb-3 text-xs text-text-400">
					<summary className="cursor-pointer">
						Review registry
						{candidates &&
							` (${flagCount(candidates, "unregistered")} unregistered, ${flagCount(candidates, "missing")} missing, ${flagCount(candidates, "skipped")} skipped)`}
					</summary>
					<div className="mt-2">
						{review((count) => `Save ${count} projects to ${inventory.registryPath}`)}
					</div>
				</details>
			)}
			{results.length === 0 ? (
				<p className="text-xs text-text-500">No ladder results yet.</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{results.map((result) => (
						<li key={result.project} className="text-sm">
							<div className="flex items-center gap-2">
								{result.stop ? (
									<OctagonAlert className="h-4 w-4 text-status-red" />
								) : (
									<CheckCircle className="h-4 w-4 text-status-green" />
								)}
								<span className="font-medium text-text-100">{result.project}</span>
								<span className="text-xs text-text-500">{result.stop ? "stopped" : "passed"}</span>
							</div>
							{result.stop && (
								<div className="ml-6 text-xs text-text-400">
									<span>{result.stop.stop}</span>
									{result.stop.branches.length > 0 && (
										<span className="ml-2 font-mono">{result.stop.branches.join(", ")}</span>
									)}
								</div>
							)}
							{result.aiStatus && (
								<div className="ml-6 flex items-center gap-1.5 text-xs text-text-400">
									<Bot className="h-3.5 w-3.5" />
									<span>AI {result.aiStatus}</span>
								</div>
							)}
							{result.testFix?.map((entry) => (
								<div
									key={entry.branch}
									className="ml-6 flex items-center gap-1.5 text-xs text-text-400"
								>
									<Bot className="h-3.5 w-3.5" />
									<span className="font-mono">{entry.branch}</span>
									<span>
										test/fix {entry.status} (attempt {entry.attempts})
									</span>
								</div>
							))}
							{result.needsAi && (
								<div className="ml-6 flex items-center gap-1.5 text-xs text-text-400">
									<Bot className="h-3.5 w-3.5" />
									<span>needs AI</span>
									<code className="font-mono">{result.needsAi.command}</code>
									<button
										type="button"
										title="Copy command"
										aria-label="Copy command"
										onClick={() => {
											const {command} = result.needsAi ?? {command: ""};
											void runPendingAction("Copy command", undefined, async () =>
												navigator.clipboard.writeText(command),
											);
										}}
										className="rounded-md border border-border-300/50 p-1 hover:bg-bg-200"
									>
										<Copy className="h-3 w-3" />
									</button>
								</div>
							)}
							{result.herdr && (
								<div className="ml-6 text-xs">
									<button
										type="button"
										onClick={() => {
											const paneId = result.herdr?.paneId ?? "";
											void runPendingAction("Focus pane", undefined, async () =>
												focusPane(paneId),
											);
										}}
										className="inline-flex items-center gap-1 rounded-md border border-border-300/50 px-2 py-0.5 text-text-200 hover:bg-bg-200"
									>
										<ExternalLink className="h-3 w-3" />
										Focus pane
									</button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
