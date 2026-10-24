import {useState} from "react";
import {Bot, CheckCircle, Copy, ExternalLink, GitMerge, Loader2, OctagonAlert} from "./icons.js";
import type {InventoryStatus, LadderResult, RegistrySummary} from "@wip/shared";
import {runPendingAction} from "../lib/pending-action.js";

function formatCounts(counts: Record<string, number>): string {
	return Object.keys(counts)
		.toSorted()
		.map((key) => `${key} ${counts[key]}`)
		.join(", ");
}

function ImportStep({
	inventory,
	importing,
	onImport,
}: {
	inventory: InventoryStatus;
	importing: boolean;
	onImport: () => void;
}) {
	const {preview} = inventory;
	const label = preview
		? `Import ${preview.total} projects into ${inventory.registryPath}`
		: `Import projects into ${inventory.registryPath}`;
	return (
		<section
			aria-label="Import project registry"
			className="mb-3 rounded-md border border-status-yellow/50 bg-bg-200 p-3 text-xs text-text-300"
		>
			<p className="mb-2">
				No project registry at <code className="font-mono">{inventory.registryPath}</code>. Import one before
				running the ladder on every project.
			</p>
			{preview && (
				<div className="mb-2 flex flex-col gap-1">
					<p className="font-medium text-text-200">
						{preview.total} projects from <code className="font-mono">{inventory.templatesDir}</code>
					</p>
					<ul className="ml-4 list-disc">
						{Object.entries(preview.byTemplate).map(([template, count]) => (
							<li key={template}>
								{template}: {count}
							</li>
						))}
					</ul>
					<p>Skipped: {preview.skipped}</p>
					<p>Conflicts: {preview.conflicts.length}</p>
					{preview.conflicts.length > 0 && (
						<ul className="ml-4 list-disc font-mono">
							{preview.conflicts.map((conflict) => (
								<li key={conflict.dir}>
									{conflict.dir} ({conflict.templates.join(", ")})
								</li>
							))}
						</ul>
					)}
				</div>
			)}
			<button
				type="button"
				disabled={importing}
				onClick={onImport}
				className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
			>
				{importing && <Loader2 className="h-4 w-4 animate-spin" />}
				{label}
			</button>
		</section>
	);
}

function ImportConfirmation({registryPath, registry}: {registryPath: string; registry: RegistrySummary}) {
	return (
		<output
			aria-label="Import complete"
			className="mb-3 block rounded-md border border-status-green/50 bg-bg-200 p-3 text-xs text-text-300"
		>
			<p className="flex items-center gap-1.5 font-medium text-text-100">
				<CheckCircle className="h-4 w-4 text-status-green" />
				Imported {registry.total} projects into <code className="font-mono">{registryPath}</code>
			</p>
			<p>Kind: {formatCounts(registry.byKind)}</p>
			<p>Template: {formatCounts(registry.byTemplate)}</p>
		</output>
	);
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
 * project registry exists the button stays disabled and an import step takes its place, so one
 * click can never fall back to scanning every directory. Once it exists a compact summary shows
 * what wip will act on, preceded by a confirmation right after an import from this page. The
 * import's pending state lives here rather than in the import step, which unmounts on success.
 * Failures surface only as a toast via runPendingAction.
 */
export function LadderSection({
	inventory,
	importInventory,
	results,
	runLadderAll,
	focusPane,
}: {
	/** Registry status; undefined while loading. */
	inventory: InventoryStatus | undefined;
	/** Writes the registry and resolves to the new status. */
	importInventory: () => Promise<InventoryStatus>;
	results: readonly LadderResult[];
	runLadderAll: () => Promise<unknown>;
	focusPane: (paneId: string) => Promise<unknown>;
}) {
	const [running, setRunning] = useState(false);
	const [importing, setImporting] = useState(false);
	const [imported, setImported] = useState<RegistrySummary | null>(null);
	const registered = inventory?.exists === true;
	const registry = inventory?.registry ?? null;

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
				<ImportStep
					inventory={inventory}
					importing={importing}
					onImport={() => {
						void runPendingAction("Import", setImporting, async () => {
							setImported((await importInventory()).registry);
						});
					}}
				/>
			)}
			{inventory && registered && imported && (
				<ImportConfirmation registryPath={inventory.registryPath} registry={imported} />
			)}
			{inventory && registry && <RegistryOverview registryPath={inventory.registryPath} registry={registry} />}
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
