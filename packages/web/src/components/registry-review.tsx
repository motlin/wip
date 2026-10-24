import {useState} from "react";
import type {ProjectRecord} from "@wip/shared";
// The client-safe module, so the browser bundle never pulls the node-only registry code.
import {
	diffInventories,
	type InventoryDiff,
	type RegistryCandidate,
	type RegistryGroup,
	type SkipReason,
	type SkipReasonCode,
} from "@wip/shared/inventory-import.js";
import {Loader2} from "./icons.js";

type Kind = ProjectRecord["kind"];

const DECISIONS: [Kind, string][] = [
	["own", "Own"],
	["fork", "Fork"],
	["nested", "Nested"],
	["skip", "Skip"],
];

const TEMPLATES: ProjectRecord["template"][] = ["project", "typescript", "java", "rust", "playdate", "unknown"];

const GROUPS: {group: RegistryGroup; label: string; word: string; hideWhenEmpty?: boolean}[] = [
	{group: "unregistered", label: "Unregistered", word: "unregistered"},
	{group: "conflict", label: "Template conflicts", word: "conflicting", hideWhenEmpty: true},
	{group: "missing", label: "Missing", word: "missing"},
	{group: "skipped", label: "Skipped", word: "skipped"},
	{group: "registered", label: "Registered", word: "registered"},
];

/** Plural nouns for the bulk skip buttons; reasons that only describe an existing skip have none. */
const SKIP_PLURALS: Partial<Record<SkipReasonCode, string>> = {
	pr: "PR worktrees",
	maven: "Maven copies",
	template: "template repos",
	parallel: "parallel worktrees",
	worktree: "git worktrees",
	"not-a-repo": "non-git directories",
	missing: "missing directories",
};

/** Rows a group card shows before its show-all button. */
const FIRST_ROWS = 25;

const BY_YOU: SkipReason = {code: "user", text: "skipped by you"};

function parseTemplate(value: string): ProjectRecord["template"] | undefined {
	return TEMPLATES.find((template) => template === value);
}

/** The project with a new decision; a note only explains a skip, so other kinds drop it. */
function decide(project: ProjectRecord, kind: Kind): ProjectRecord {
	if (kind === "skip") return {...project, kind};
	const {skipNote: _dropped, ...rest} = project;
	return {...rest, kind};
}

function describe(project: ProjectRecord): string {
	return `${project.name} (${project.template}, ${project.kind}) ${project.dir}`;
}

function describeChange({before, after}: InventoryDiff["changed"][number]): string {
	const changes = (["name", "template", "kind"] as const)
		.filter((key) => before[key] !== after[key])
		.map((key) => `${before[key]} → ${after[key]}`);
	if (before.skipNote !== after.skipNote) changes.push(`note "${before.skipNote ?? ""}" → "${after.skipNote ?? ""}"`);
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

const cardClass = "mb-3 rounded-lg border border-border-300/50 bg-bg-100 p-3 text-xs text-text-300";
const buttonClass =
	"rounded-md border border-border-300/50 px-2 py-0.5 text-xs text-text-200 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50";
const selectClass = "rounded border border-border-300/50 bg-bg-100 px-1 py-0.5 text-xs text-text-200";

function CandidateRow({
	row,
	onDecide,
	onTemplate,
	onNote,
}: {
	row: RegistryCandidate;
	onDecide: (kind: Kind) => void;
	onTemplate: (template: ProjectRecord["template"]) => void;
	onNote: (note: string) => void;
}) {
	const {name, dir, template, kind, skipNote} = row.project;
	const skipped = kind === "skip";
	const reason = row.skipReason ?? BY_YOU;
	return (
		<li aria-label={name} className="border-t border-border-300/30 py-1.5 first:border-t-0">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium text-text-100">{name}</span>
				<span className="font-mono break-all text-text-400">{dir}</span>
				{row.group === "conflict" ? (
					<select
						aria-label={`Template for ${name}`}
						value={template}
						onChange={(event) => {
							const next = parseTemplate(event.target.value);
							if (next) onTemplate(next);
						}}
						className={selectClass}
					>
						{TEMPLATES.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				) : (
					<span className="text-text-400">{template}</span>
				)}
				<div
					role="radiogroup"
					aria-label={`Decision for ${name}`}
					className="ml-auto inline-flex overflow-hidden rounded-md border border-border-300/50"
				>
					{DECISIONS.map(([value, label]) => (
						<label key={value} className="cursor-pointer">
							<input
								type="radio"
								name={`decision-${dir}`}
								checked={kind === value}
								onChange={() => {
									onDecide(value);
								}}
								className="peer sr-only"
							/>
							<span className="block px-2 py-0.5 text-text-200 peer-checked:bg-bg-300 peer-checked:text-text-100 peer-focus-visible:ring-1 hover:bg-bg-200">
								{label}
							</span>
						</label>
					))}
				</div>
			</div>
			{row.note && !(skipped && row.note === reason.text) && <p className="text-text-400">{row.note}</p>}
			{skipped && (
				<p className="mt-0.5 flex flex-wrap items-center gap-2 text-text-400">
					<span data-skip-reason>{reason.text}</span>
					{reason.code === "user" && (
						<input
							type="text"
							aria-label={`Skip note for ${name}`}
							placeholder="optional note"
							value={skipNote ?? ""}
							onChange={(event) => {
								onNote(event.target.value);
							}}
							className="rounded border border-border-300/50 bg-bg-100 px-1 py-0.5 text-xs text-text-200"
						/>
					)}
				</p>
			)}
		</li>
	);
}

interface BulkAction {
	label: string;
	dirs: ReadonlySet<string>;
	kind: Kind;
	/** Whether every row it targets already has that decision. */
	done: boolean;
}

/** One skip action per reason and one Own action per template, wherever at least two rows share it. */
function bulkActions(rows: RegistryCandidate[], word: string): BulkAction[] {
	const actions: BulkAction[] = [];
	const add = (label: string, targets: RegistryCandidate[], kind: Kind) => {
		if (targets.length < 2) return;
		const dirs = new Set(targets.map((row) => row.project.dir));
		actions.push({label, dirs, kind, done: targets.every((row) => row.project.kind === kind)});
	};
	for (const [code, plural] of Object.entries(SKIP_PLURALS)) {
		const targets = rows.filter((row) => row.skipReason?.code === code);
		add(`Skip all ${targets.length} ${plural}`, targets, "skip");
	}
	for (const template of TEMPLATES) {
		const targets = rows.filter((row) => row.project.template === template);
		add(`Mark all ${targets.length} ${word} ${template} repos Own`, targets, "own");
	}
	return actions;
}

function GroupCard({
	label,
	word,
	rows,
	edit,
}: {
	label: string;
	word: string;
	rows: RegistryCandidate[];
	edit: (dirs: ReadonlySet<string>, change: (project: ProjectRecord) => ProjectRecord) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const id = `registry-group-${word}`;
	const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);
	const actions = bulkActions(rows, word);
	return (
		<section aria-labelledby={id} className={cardClass}>
			<h3 id={id} className="mb-1 text-sm font-semibold text-text-200">
				{label} ({rows.length})
			</h3>
			{actions.length > 0 && (
				<div className="mb-1 flex flex-wrap gap-1">
					{actions.map((action) => (
						<button
							key={action.label}
							type="button"
							disabled={action.done}
							onClick={() => {
								edit(action.dirs, (project) => decide(project, action.kind));
							}}
							className={buttonClass}
						>
							{action.label}
						</button>
					))}
				</div>
			)}
			{rows.length === 0 ? (
				<p className="text-text-500">None</p>
			) : (
				<ul>
					{shown.map((row) => {
						const only = new Set([row.project.dir]);
						return (
							<CandidateRow
								key={row.project.dir}
								row={row}
								onDecide={(kind) => {
									edit(only, (project) => decide(project, kind));
								}}
								onTemplate={(template) => {
									edit(only, (project) => ({...project, template}));
								}}
								onNote={(note) => {
									edit(only, (project) => {
										const {skipNote: _old, ...rest} = project;
										return note === "" ? rest : {...rest, skipNote: note};
									});
								}}
							/>
						);
					})}
				</ul>
			)}
			{rows.length > shown.length && (
				<button
					type="button"
					onClick={() => {
						setShowAll(true);
					}}
					className={`${buttonClass} mt-1`}
				>
					Show all {rows.length}
				</button>
			)}
		</section>
	);
}

/**
 * Every registry candidate as visible group cards (Unregistered, Missing, Skipped, Registered,
 * plus template conflicts when there are any). Each row has one decision, Own, Fork, Nested, or
 * Skip, and every skip shows the server's reason for it, or the user's own note when they chose it
 * by hand. Bulk actions apply one decision to a group's rows sharing a skip reason or template.
 * Saving is two steps: Review changes shows the diff against the current registry, and only then
 * does the save button appear.
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
	const [diff, setDiff] = useState<InventoryDiff | null>(null);
	const projects = rows.map((row) => row.project);

	function edit(dirs: ReadonlySet<string>, change: (project: ProjectRecord) => ProjectRecord) {
		setRows((previous) =>
			previous.map((row) => (dirs.has(row.project.dir) ? {...row, project: change(row.project)} : row)),
		);
		setDiff(null);
	}

	return (
		<>
			{GROUPS.map(({group, label, word, hideWhenEmpty}) => {
				const groupRows = rows.filter((row) => row.group === group);
				if (hideWhenEmpty && groupRows.length === 0) return null;
				return <GroupCard key={group} label={label} word={word} rows={groupRows} edit={edit} />;
			})}
			<section aria-label="Save registry" className={cardClass}>
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => {
							setDiff(diffInventories(current, projects));
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
								onSave(projects);
							}}
							className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
						>
							{saving && <Loader2 className="h-4 w-4 animate-spin" />}
							{saveLabel(projects.length)}
						</button>
					)}
				</div>
				{diff && <DiffView diff={diff} />}
			</section>
		</>
	);
}
