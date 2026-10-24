import {useState, type ReactNode} from "react";
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

interface GroupSpec {
	group: RegistryGroup;
	label: string;
	word: string;
	hideWhenEmpty?: boolean;
	/** One line under the heading saying what the group means. */
	explanation?: string;
}

/** Groups whose rows wait for a decision; a decided row leaves its card. */
const INBOX: GroupSpec[] = [
	{group: "unregistered", label: "Unregistered", word: "unregistered"},
	{group: "conflict", label: "Template conflicts", word: "conflicting", hideWhenEmpty: true},
];

/** Groups already in the registry, shown as a report the user may still correct. */
const REPORT: GroupSpec[] = [
	{group: "registered", label: "Registered", word: "registered", explanation: "Kept up to date by wip ladder --all."},
	{
		group: "skipped",
		label: "Skipped",
		word: "skipped",
		explanation: "In the registry but left out of wip ladder --all.",
	},
	{
		group: "missing",
		label: "Missing",
		word: "missing",
		explanation: "In the registry, but the directory is gone or isn't a git repo.",
	},
];

const INBOX_GROUPS: ReadonlySet<RegistryGroup> = new Set(INBOX.map((spec) => spec.group));

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
	return (
		<section aria-label="Registry changes" className="mt-2 rounded-md border border-border-300/50 p-2 font-mono">
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
		</section>
	);
}

const cardClass = "mb-3 rounded-lg border border-border-300/50 bg-bg-100 p-3 text-xs text-text-300";
const buttonClass =
	"rounded-md border border-border-300/50 px-2 py-0.5 text-xs text-text-200 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50";
const selectClass = "rounded border border-border-300/50 bg-bg-100 px-1 py-0.5 text-xs text-text-200";

function CandidateRow({
	row,
	undecided,
	onDecide,
	onTemplate,
	onNote,
	onUndo,
}: {
	row: RegistryCandidate;
	/** An inbox row: no option is checked, and the server's default shows as a suggestion. */
	undecided: boolean;
	onDecide: (kind: Kind) => void;
	onTemplate: (template: ProjectRecord["template"]) => void;
	onNote: (note: string) => void;
	/** Returns a decided row to the inbox; only decided inbox rows have it. */
	onUndo?: () => void;
}) {
	const {name, dir, template, kind, skipNote} = row.project;
	const skipped = kind === "skip";
	const reason = row.skipReason ?? BY_YOU;
	const suggestion = DECISIONS.find(([value]) => value === kind)?.[1];
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
				{undecided && (
					<span data-suggestion className="ml-auto text-text-400">
						suggested: {suggestion}
					</span>
				)}
				<div
					role="radiogroup"
					aria-label={`Decision for ${name}`}
					className={`${undecided ? "" : "ml-auto "}inline-flex overflow-hidden rounded-md border border-border-300/50`}
				>
					{DECISIONS.map(([value, label]) => (
						<label key={value} className="cursor-pointer">
							<input
								type="radio"
								name={`decision-${dir}`}
								checked={!undecided && kind === value}
								onChange={() => {
									onDecide(value);
								}}
								className="peer sr-only"
							/>
							<span
								className={`block px-2 py-0.5 text-text-200 peer-checked:bg-bg-300 peer-checked:text-text-100 peer-focus-visible:ring-1 hover:bg-bg-200 ${
									undecided && kind === value ? "underline decoration-dotted" : ""
								}`}
							>
								{label}
							</span>
						</label>
					))}
				</div>
				{onUndo && (
					<button
						type="button"
						aria-label={`Undo decision for ${name}`}
						onClick={onUndo}
						className={buttonClass}
					>
						Undo
					</button>
				)}
			</div>
			{row.note && !(skipped && row.note === reason.text) && <p className="text-text-400">{row.note}</p>}
			{skipped && (
				<p className="mt-0.5 flex flex-wrap items-center gap-2 text-text-400">
					<span data-skip-reason>{reason.text}</span>
					{reason.code === "user" && !undecided && (
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
function bulkActions(rows: RegistryCandidate[], word: string, undecided: boolean): BulkAction[] {
	const actions: BulkAction[] = [];
	const add = (label: string, targets: RegistryCandidate[], kind: Kind) => {
		if (targets.length < 2) return;
		const dirs = new Set(targets.map((row) => row.project.dir));
		const done = !undecided && targets.every((row) => row.project.kind === kind);
		actions.push({label, dirs, kind, done});
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

/** Applies a change to the rows in dirs; a decision also takes them out of the inbox. */
type Edit = (dirs: ReadonlySet<string>, change: (project: ProjectRecord) => ProjectRecord, decides?: boolean) => void;

function GroupCard({
	label,
	word,
	heading,
	explanation,
	group,
	rows,
	undecided,
	edit,
	onUndo,
	children,
}: {
	/** The card's accessible name, before its count. */
	label: string;
	word: string;
	/** The visible heading; the label and count when absent. */
	heading?: string;
	explanation?: string;
	group?: RegistryGroup;
	rows: RegistryCandidate[];
	undecided: boolean;
	edit: Edit;
	onUndo?: (dir: string) => void;
	children?: ReactNode;
}) {
	const [showAll, setShowAll] = useState(false);
	const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);
	const actions = bulkActions(rows, word, undecided);
	const name = `${label} (${rows.length})`;
	return (
		<section aria-label={name} data-registry-group={group} className={cardClass}>
			<h3 className="mb-1 text-sm font-semibold text-text-200">{heading ?? name}</h3>
			{explanation && <p data-explanation>{explanation}</p>}
			{children}
			{actions.length > 0 && (
				<div className="mb-1 flex flex-wrap gap-1">
					{actions.map((action) => (
						<button
							key={action.label}
							type="button"
							disabled={action.done}
							onClick={() => {
								edit(action.dirs, (project) => decide(project, action.kind), true);
							}}
							className={buttonClass}
						>
							{action.label}
						</button>
					))}
				</div>
			)}
			{rows.length === 0 ? (
				heading === undefined && <p className="text-text-500">None</p>
			) : (
				<ul>
					{shown.map((row) => {
						const only = new Set([row.project.dir]);
						return (
							<CandidateRow
								key={row.project.dir}
								row={row}
								undecided={undecided}
								onDecide={(kind) => {
									edit(only, (project) => decide(project, kind), true);
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
								onUndo={
									onUndo &&
									(() => {
										onUndo(row.project.dir);
									})
								}
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

function inboxHeading(remaining: number, decided: number): string {
	if (remaining > 0) return `${remaining} repos aren't kept up to date by Update all yet: decide each one`;
	if (decided > 0) return "Every repo is decided: save to finish";
	return "Every repo is kept up to date by Update all";
}

/**
 * The registry review as an inbox that clears. Unregistered repos and template conflicts wait for
 * one decision each, Own, Fork, Nested, or Skip, with the server's default shown only as a
 * suggestion; a decided row leaves the inbox for a decided card until it is saved or undone. The
 * registry's own rows (Registered, Skipped, Missing) follow as a lower report the user may still
 * correct. Every skip shows the server's reason, or the user's note when they chose it by hand, and
 * bulk actions apply one decision to a card's rows sharing a skip reason or template. A sticky save
 * bar is always visible: it counts what is left to decide and saves or discards the changes, which
 * it can show as a diff against the current registry. Undecided unregistered repos are not saved.
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
	/** The save button's text, from the number of changes and of projects it would write. */
	saveLabel: (changes: number, projects: number) => string;
	saving: boolean;
	onSave: (projects: ProjectRecord[]) => void;
}) {
	const [rows, setRows] = useState(candidates);
	const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
	const [showDiff, setShowDiff] = useState(false);

	function discard() {
		setRows(candidates);
		setDecided(new Set());
		setShowDiff(false);
	}

	// New candidates (a fetch replacing a persisted list, or a save) restart the review; the
	// query's structural sharing keeps the same array while the server's answer is unchanged.
	const [shownCandidates, setShownCandidates] = useState(candidates);
	if (shownCandidates !== candidates) {
		setShownCandidates(candidates);
		discard();
	}

	const projects = rows
		.filter((row) => row.group !== "unregistered" || decided.has(row.project.dir))
		.map((row) => row.project);
	const diff = diffInventories(current, projects);
	const changes = diff.added.length + diff.removed.length + diff.changed.length;
	const inboxRows = rows.filter((row) => INBOX_GROUPS.has(row.group));
	const decidedRows = inboxRows.filter((row) => decided.has(row.project.dir));
	const remaining = inboxRows.length - decidedRows.length;

	const edit: Edit = (dirs, change, decides = false) => {
		setRows((previous) =>
			previous.map((row) => (dirs.has(row.project.dir) ? {...row, project: change(row.project)} : row)),
		);
		if (decides) setDecided((previous) => new Set([...previous, ...dirs]));
	};

	function undo(dir: string) {
		const original = candidates.find((row) => row.project.dir === dir);
		if (original) edit(new Set([dir]), () => original.project);
		setDecided((previous) => new Set([...previous].filter((other) => other !== dir)));
	}

	const groupRows = (group: RegistryGroup) => rows.filter((row) => row.group === group);

	return (
		<>
			{INBOX.map(({group, label, word, hideWhenEmpty}) => {
				const all = groupRows(group);
				if (hideWhenEmpty && all.length === 0) return null;
				const waiting = all.filter((row) => !decided.has(row.project.dir));
				const unregistered = group === "unregistered";
				return (
					<GroupCard
						key={group}
						group={group}
						label={label}
						word={word}
						heading={unregistered ? inboxHeading(remaining, decidedRows.length) : undefined}
						rows={waiting}
						undecided
						edit={edit}
					>
						{unregistered && (
							<p className="mb-1">
								The registry decides what wip ladder --all keeps up to date: it keeps Own, Fork, and
								Nested repos and leaves out Skip. Decided repos move below until you save.
							</p>
						)}
					</GroupCard>
				);
			})}
			{decidedRows.length > 0 && (
				<GroupCard
					label="Decided, not saved yet"
					word="decided"
					rows={decidedRows}
					undecided={false}
					edit={edit}
					onUndo={undo}
				/>
			)}
			<section aria-label="In the registry" className="mt-4">
				<h3 className="mb-1 text-sm font-semibold text-text-300">In the registry</h3>
				<p className="mb-2 text-xs text-text-400">
					What the saved registry already says; change a row here to correct it.
				</p>
				{REPORT.map(({group, label, word, explanation}) => (
					<GroupCard
						key={group}
						group={group}
						label={label}
						word={word}
						explanation={explanation}
						rows={groupRows(group)}
						undecided={false}
						edit={edit}
					/>
				))}
			</section>
			<section aria-label="Save registry" className={`${cardClass} sticky bottom-2 z-10 shadow-lg`}>
				<div className="flex flex-wrap items-center gap-2">
					<span data-remaining className="mr-auto text-text-200">
						{remaining} left to decide
					</span>
					{changes > 0 && (
						<>
							<button
								type="button"
								onClick={() => {
									setShowDiff((shown) => !shown);
								}}
								className={buttonClass}
							>
								{showDiff ? "Hide changes" : "Show changes"}
							</button>
							<button type="button" disabled={saving} onClick={discard} className={buttonClass}>
								Discard
							</button>
						</>
					)}
					<button
						type="button"
						disabled={saving || changes === 0}
						onClick={() => {
							onSave(projects);
						}}
						className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
					>
						{saving && <Loader2 className="h-4 w-4 animate-spin" />}
						{changes === 0 ? "No changes yet" : saveLabel(changes, projects.length)}
					</button>
				</div>
				{showDiff && changes > 0 && <DiffView diff={diff} />}
			</section>
		</>
	);
}
