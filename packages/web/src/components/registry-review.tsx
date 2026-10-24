import {useState} from "react";
import type {ProjectRecord} from "@wip/shared";
// The client-safe module, so the browser bundle never pulls the node-only registry code.
import {diffInventories, type InventoryDiff, type RegistryCandidate} from "@wip/shared/inventory-import.js";
import {Loader2} from "./icons.js";

type Filter = "all" | "unregistered" | "missing" | "skipped" | "conflict";

const FILTERS: [Filter, string][] = [
	["all", "All"],
	["unregistered", "Unregistered"],
	["missing", "Missing"],
	["skipped", "Skipped"],
	["conflict", "Conflicts"],
];

const KINDS: ProjectRecord["kind"][] = ["own", "fork", "nested", "skip"];
const TEMPLATES: ProjectRecord["template"][] = ["project", "typescript", "java", "rust", "playdate", "unknown"];

function parseKind(value: string): ProjectRecord["kind"] | undefined {
	return KINDS.find((kind) => kind === value);
}

function parseTemplate(value: string): ProjectRecord["template"] | undefined {
	return TEMPLATES.find((template) => template === value);
}

function describe(project: ProjectRecord): string {
	return `${project.name} (${project.template}, ${project.kind}) ${project.dir}`;
}

function describeChange({before, after}: InventoryDiff["changed"][number]): string {
	const changes = (["name", "template", "kind"] as const)
		.filter((key) => before[key] !== after[key])
		.map((key) => `${before[key]} → ${after[key]}`);
	return `${before.name}: ${changes.join(", ")}`;
}

function DiffView({diff}: {diff: InventoryDiff}) {
	const empty = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
	return (
		<section aria-label="Registry changes" className="mt-2 rounded-md border border-border-300/50 p-2 font-mono">
			{empty ? (
				<p className="font-sans">No changes</p>
			) : (
				<ul>
					{diff.added.map((project) => (
						<li key={project.dir} className="text-status-green">
							+ {describe(project)}
						</li>
					))}
					{diff.removed.map((project) => (
						<li key={project.dir} className="text-status-red">
							- {describe(project)}
						</li>
					))}
					{diff.changed.map((change) => (
						<li key={change.after.dir} className="text-status-yellow">
							~ {describeChange(change)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

const selectClass = "rounded border border-border-300/50 bg-bg-100 px-1 py-0.5 text-xs text-text-200";
const buttonClass =
	"rounded-md border border-border-300/50 px-2 py-0.5 text-xs text-text-200 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Every registry candidate in an editable table: include or exclude each row, change its kind or
 * template, filter by flag, and apply bulk edits to selected rows. Saving is two steps: Review
 * changes shows the diff against the current registry, and only then does the save button appear.
 */
export function RegistryReview({
	candidates,
	current,
	saveLabel,
	saving,
	onSave,
}: {
	candidates: readonly RegistryCandidate[];
	/** The registry as saved now; empty before the first import. */
	current: ProjectRecord[];
	saveLabel: (count: number) => string;
	saving: boolean;
	onSave: (projects: ProjectRecord[]) => void;
}) {
	const [rows, setRows] = useState(candidates);
	const [filter, setFilter] = useState<Filter>("all");
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [diff, setDiff] = useState<InventoryDiff | null>(null);

	const shown = filter === "all" ? rows : rows.filter((row) => row.flags.includes(filter));
	const included = rows.filter((row) => row.included).map((row) => row.project);
	const allShownSelected = shown.length > 0 && shown.every((row) => selected.has(row.project.dir));

	function edit(dirs: ReadonlySet<string>, change: (row: RegistryCandidate) => RegistryCandidate) {
		setRows((previous) => previous.map((row) => (dirs.has(row.project.dir) ? change(row) : row)));
		setDiff(null);
	}

	function toggleSelected(dir: string) {
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(dir)) next.delete(dir);
			else next.add(dir);
			return next;
		});
	}

	return (
		<div className="text-xs text-text-300">
			<div className="mb-2 flex flex-wrap gap-1">
				{FILTERS.map(([value, label]) => {
					const count =
						value === "all" ? rows.length : rows.filter((row) => row.flags.includes(value)).length;
					return (
						<button
							key={value}
							type="button"
							aria-pressed={filter === value}
							onClick={() => {
								setFilter(value);
							}}
							className={`${buttonClass} aria-pressed:bg-bg-300 aria-pressed:text-text-100`}
						>
							{label} ({count})
						</button>
					);
				})}
			</div>
			<div className="mb-2 flex flex-wrap items-center gap-1">
				<span>{selected.size} selected</span>
				<button
					type="button"
					disabled={selected.size === 0}
					onClick={() => {
						edit(selected, (row) => ({...row, included: true}));
					}}
					className={buttonClass}
				>
					Include selected
				</button>
				<button
					type="button"
					disabled={selected.size === 0}
					onClick={() => {
						edit(selected, (row) => ({...row, included: false}));
					}}
					className={buttonClass}
				>
					Exclude selected
				</button>
				<select
					aria-label="Kind for selected"
					value=""
					disabled={selected.size === 0}
					onChange={(event) => {
						const kind = parseKind(event.target.value);
						if (kind) edit(selected, (row) => ({...row, project: {...row.project, kind}}));
					}}
					className={selectClass}
				>
					<option value="" disabled>
						Set kind…
					</option>
					{KINDS.map((kind) => (
						<option key={kind} value={kind}>
							{kind}
						</option>
					))}
				</select>
			</div>
			<div className="max-h-96 overflow-auto rounded-md border border-border-300/50">
				<table className="w-full text-left">
					<thead className="sticky top-0 bg-bg-200 text-text-400">
						<tr>
							<th className="p-1">
								<input
									type="checkbox"
									aria-label="Select all shown"
									checked={allShownSelected}
									onChange={() => {
										const dirs = shown.map((row) => row.project.dir);
										setSelected((previous) => {
											const next = new Set(previous);
											for (const dir of dirs) {
												if (allShownSelected) next.delete(dir);
												else next.add(dir);
											}
											return next;
										});
									}}
								/>
							</th>
							<th className="p-1">Include</th>
							<th className="p-1">Name</th>
							<th className="p-1">Dir</th>
							<th className="p-1">Template</th>
							<th className="p-1">Kind</th>
							<th className="p-1">Note</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((row) => {
							const {name, dir, template, kind} = row.project;
							const only = new Set([dir]);
							return (
								<tr
									key={dir}
									data-name={name}
									className={`border-t border-border-300/30 ${row.included ? "" : "opacity-60"}`}
								>
									<td className="p-1">
										<input
											type="checkbox"
											aria-label={`Select ${name}`}
											checked={selected.has(dir)}
											onChange={() => {
												toggleSelected(dir);
											}}
										/>
									</td>
									<td className="p-1">
										<input
											type="checkbox"
											aria-label={`Include ${name}`}
											checked={row.included}
											onChange={() => {
												edit(only, (r) => ({...r, included: !r.included}));
											}}
										/>
									</td>
									<td className="p-1 font-medium text-text-100">{name}</td>
									<td className="p-1 font-mono break-all">{dir}</td>
									<td className="p-1">
										<select
											aria-label={`Template for ${name}`}
											value={template}
											onChange={(event) => {
												const next = parseTemplate(event.target.value);
												if (next)
													edit(only, (r) => ({
														...r,
														project: {...r.project, template: next},
													}));
											}}
											className={selectClass}
										>
											{TEMPLATES.map((value) => (
												<option key={value} value={value}>
													{value}
												</option>
											))}
										</select>
									</td>
									<td className="p-1">
										<select
											aria-label={`Kind for ${name}`}
											value={kind}
											onChange={(event) => {
												const next = parseKind(event.target.value);
												if (next)
													edit(only, (r) => ({...r, project: {...r.project, kind: next}}));
											}}
											className={selectClass}
										>
											{KINDS.map((value) => (
												<option key={value} value={value}>
													{value}
												</option>
											))}
										</select>
									</td>
									<td className="p-1 text-text-400">{row.hint}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => {
						setDiff(diffInventories(current, included));
					}}
					className={buttonClass}
				>
					Review changes
				</button>
				{diff && (
					<button
						type="button"
						disabled={
							saving ||
							(diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0)
						}
						onClick={() => {
							onSave(included);
						}}
						className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
					>
						{saving && <Loader2 className="h-4 w-4 animate-spin" />}
						{saveLabel(included.length)}
					</button>
				)}
			</div>
			{diff && <DiffView diff={diff} />}
		</div>
	);
}
