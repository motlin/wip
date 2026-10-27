import {useState, type ReactNode} from "react";
import type {ProjectRecord} from "@wip/shared";
// The client-safe module, so the browser bundle never pulls the node-only registry code.
import {
	diffInventories,
	landingMode,
	type InventoryDiff,
	type LandingMode,
	type RegistryCandidate,
	type RegistryGroup,
	type SkipReason,
	type SkipReasonCode,
} from "@wip/shared/inventory-import.js";
import {CheckCircle, Loader2} from "./icons.js";

type Kind = ProjectRecord["kind"];

/** Each decision's chip color once chosen: kept kinds in green, blue, and purple, a skip in muted gray. */
const DECISION_COLORS: Record<Kind, string> = {
	own: "peer-checked:bg-btn-success-bg peer-checked:text-btn-success-text",
	fork: "peer-checked:bg-blue-column peer-checked:text-blue-700 dark:peer-checked:text-blue-300",
	nested: "peer-checked:bg-purple-column peer-checked:text-purple-700 dark:peer-checked:text-purple-300",
	skip: "peer-checked:bg-bg-300 peer-checked:text-text-300",
};

const DECISIONS: [Kind, string][] = [
	["own", "Own"],
	["fork", "Fork"],
	["nested", "Nested"],
	["skip", "Skip"],
];

const TEMPLATES: ProjectRecord["template"][] = ["project", "typescript", "java", "rust", "playdate", "unknown"];

const LANDINGS: [LandingMode, string][] = [
	["pull-request", "lands via pull request"],
	["fast-forward", "lands by fast-forward"],
];

interface GroupSpec {
	group: RegistryGroup;
	label: string;
	word: string;
	hideWhenEmpty?: boolean;
	/** One line under the heading saying what the group means. */
	explanation?: string;
}

/** A `<repo>-test-worktree` wip skips on its own; it needs no decision and no registry entry. */
function isAutomaticSkip(row: RegistryCandidate): boolean {
	return row.skipReason?.code === "test-worktree" && row.project.kind === "skip";
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

/**
 * Plural nouns for the skip reasons that mark a copy of another repo. Many copies are git worktrees
 * under another name (a Maven copy, a PR worktree), so one bulk action skips every copy and its
 * label counts each kind.
 */
const COPY_PLURALS: Partial<Record<SkipReasonCode, string>> = {
	pr: "PR worktrees",
	maven: "Maven copies",
	template: "template repos",
	parallel: "parallel worktrees",
	worktree: "git worktrees",
};

/** Plural nouns for the other bulk skip buttons; reasons that only describe an existing skip have none. */
const SKIP_PLURALS: Partial<Record<SkipReasonCode, string>> = {
	"not-a-repo": "non-git directories",
	missing: "missing directories",
};

/** Rows a group card shows before its show-all button. */
const FIRST_ROWS = 25;

const BY_YOU: SkipReason = {code: "user", text: "skipped by you"};

function parseTemplate(value: string): ProjectRecord["template"] | undefined {
	return TEMPLATES.find((template) => template === value);
}

function parseLanding(value: string): LandingMode | undefined {
	return LANDINGS.find(([landing]) => landing === value)?.[0];
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
	if (before.landing !== after.landing) changes.push(`landing ${landingMode(before)} → ${landingMode(after)}`);
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
	"rounded-md border border-border-300/50 bg-bg-000 px-2 py-0.5 text-xs text-text-100 hover:bg-bg-200 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
	"inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70";
const selectClass = "rounded border border-border-300/50 bg-bg-100 px-1 py-0.5 text-xs text-text-100";

/** Keyboard focus scrolls a control clear of the sticky save bar, which covers the viewport's bottom 6rem at most. */
const clearOfSaveBar = "[&_:is(button,input,select)]:scroll-mb-24";

function CandidateRow({
	row,
	undecided,
	onDecide,
	onTemplate,
	onNote,
	onLanding,
	onUndo,
}: {
	row: RegistryCandidate;
	/** An inbox row: no option is checked, and the server's default shows as a suggestion. */
	undecided: boolean;
	onDecide: (kind: Kind) => void;
	onTemplate: (template: ProjectRecord["template"]) => void;
	onNote: (note: string) => void;
	/** Sets the landing mode explicitly, overriding the default derived from the kind. */
	onLanding: (landing: LandingMode) => void;
	/** Returns a decided row to the inbox; only decided inbox rows have it. */
	onUndo?: () => void;
}) {
	const {name, dir, template, kind, skipNote} = row.project;
	const skipped = kind === "skip";
	const reason = row.skipReason ?? BY_YOU;
	const suggestion = DECISIONS.find(([value]) => value === kind)?.[1];
	return (
		<li
			aria-label={name}
			className="flex flex-col gap-1.5 border-t border-border-300/30 py-2 first:border-t-0 sm:flex-row sm:items-center sm:gap-3"
		>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
					<span className="text-sm font-medium text-text-100">{name}</span>
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
						<span className="rounded bg-bg-200 px-1.5 text-[11px] text-text-300">{template}</span>
					)}
					{!skipped && (
						<select
							aria-label={`Landing for ${name}`}
							title={
								row.project.landing === undefined
									? "Default for the kind: forks land via pull request, other repos by fast-forward. The ready buffer force-pushes ready commits only in pull-request repos."
									: "Set in the registry. The ready buffer force-pushes ready commits only in pull-request repos."
							}
							value={landingMode(row.project)}
							onChange={(event) => {
								const next = parseLanding(event.target.value);
								if (next) onLanding(next);
							}}
							className={selectClass}
						>
							{LANDINGS.map(([value, label]) => (
								<option key={value} value={value}>
									{label}
									{row.project.landing === undefined && value === landingMode(row.project)
										? " (default)"
										: ""}
								</option>
							))}
						</select>
					)}
				</div>
				<span className="block truncate font-mono text-[11px] text-text-500" title={dir}>
					{dir}
				</span>
				{row.note && !(skipped && row.note === reason.text) && <p className="text-text-500">{row.note}</p>}
				{skipped && (
					<p className="mt-0.5 flex flex-wrap items-center gap-2 text-text-500">
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
								className={selectClass}
							/>
						)}
					</p>
				)}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{undecided && (
					<span data-suggestion className="text-text-500">
						suggested: {suggestion}
					</span>
				)}
				<div
					role="radiogroup"
					aria-label={`Decision for ${name}`}
					className="inline-flex overflow-hidden rounded-md border border-border-300/60 bg-bg-000"
				>
					{DECISIONS.map(([value, label]) => (
						<label key={value} className="cursor-pointer border-l border-border-300/40 first:border-l-0">
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
								data-kind={value}
								className={`block px-2.5 py-1 text-text-300 peer-checked:font-semibold peer-focus-visible:ring-1 hover:bg-bg-200 ${DECISION_COLORS[value]} ${
									undecided && kind === value ? "underline decoration-dotted underline-offset-2" : ""
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
		</li>
	);
}

interface BulkAction {
	/** Stable across counts, so a kept question stays answered as rows change. */
	key: string;
	label: string;
	/** The visible start of the label on a question's button, short enough for one line. */
	short: string;
	/** The action asked as a yes-or-no question. */
	question: string;
	/** What the rows it targets have in common, and why the decision fits them. */
	covers: string;
	names: string[];
	dirs: ReadonlySet<string>;
	kind: Kind;
	/** Whether every row it targets already has that decision. */
	done: boolean;
}

/** How many copies of each kind, in COPY_PLURALS order. */
function copyKinds(copies: RegistryCandidate[]): (readonly [number, string])[] {
	return Object.entries(COPY_PLURALS)
		.map(([code, plural]) => [copies.filter((row) => row.skipReason?.code === code).length, plural] as const)
		.filter(([count]) => count > 0);
}

/** "Skip all N copies (a PR worktrees, b git worktrees)", or the one kind's own label when only one is present. */
function copiesLabel(copies: RegistryCandidate[]): string {
	const kinds = copyKinds(copies);
	if (kinds.length === 1) return `Skip all ${copies.length} ${kinds[0]?.[1]}`;
	return `Skip all ${copies.length} copies (${kinds.map(([count, plural]) => `${count} ${plural}`).join(", ")})`;
}

/**
 * One skip action for every copy, one per other skip reason, and one Own action per template,
 * wherever at least two rows share it. Each label counts exactly the rows it decides.
 */
function bulkActions(rows: RegistryCandidate[], word: string, undecided: boolean): BulkAction[] {
	const actions: BulkAction[] = [];
	const add = (
		key: string,
		targets: RegistryCandidate[],
		kind: Kind,
		text: {label: string; short: string; question: string; covers: string},
	) => {
		if (targets.length < 2) return;
		const dirs = new Set(targets.map((row) => row.project.dir));
		const done = !undecided && targets.every((row) => row.project.kind === kind);
		actions.push({key, ...text, names: targets.map((row) => row.project.name), dirs, kind, done});
	};
	const copyCodes = new Set(Object.keys(COPY_PLURALS));
	const copies = rows.filter((row) => row.skipReason !== undefined && copyCodes.has(row.skipReason.code));
	const kinds = copyKinds(copies);
	const [onlyKind] = kinds;
	const copyNoun = kinds.length === 1 && onlyKind ? onlyKind[1] : "copies";
	add("copies", copies, "skip", {
		label: copiesLabel(copies),
		short: `Skip all ${copies.length} ${copyNoun}`,
		question: `Skip the ${copies.length} ${kinds.length === 1 ? copyNoun : "copies of other repos"}?`,
		covers: `Copies of another repo (${kinds.map(([count, plural]) => `${count} ${plural}`).join(", ")}). wip ladder --all already updates the original, so a copy only adds work.`,
	});
	for (const [code, plural] of Object.entries(SKIP_PLURALS)) {
		const targets = rows.filter((row) => row.skipReason?.code === code);
		add(`skip:${code}`, targets, "skip", {
			label: `Skip all ${targets.length} ${plural}`,
			short: `Skip all ${targets.length} ${plural}`,
			question: `Skip the ${targets.length} ${plural}?`,
			covers:
				code === "missing"
					? "The directory is gone, so wip ladder --all has nothing to update."
					: "Directories without a git repo, so wip ladder --all has nothing to update.",
		});
	}
	for (const template of TEMPLATES) {
		const targets = rows.filter((row) => row.project.template === template);
		add(`own:${template}`, targets, "own", {
			label: `Mark all ${targets.length} ${word} ${template} repos Own`,
			short: `Mark all ${targets.length} Own`,
			question: `Mark the ${targets.length} ${word} ${template} repos Own?`,
			covers: `Every ${word} repo on the ${template} template. Own means wip ladder --all keeps it up to date.`,
		});
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
	askedAbove = false,
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
	/** Its bulk actions are asked as quick questions above, so the card leaves them out. */
	askedAbove?: boolean;
	children?: ReactNode;
}) {
	const [showAll, setShowAll] = useState(false);
	const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);
	const actions = askedAbove ? [] : bulkActions(rows, word, undecided);
	const name = `${label} (${rows.length})`;
	return (
		<section aria-label={name} data-registry-group={group} className={cardClass}>
			<h3 className="mb-1 text-sm font-semibold text-text-100">{heading ?? name}</h3>
			{explanation && (
				<p data-explanation className="text-text-500">
					{explanation}
				</p>
			)}
			{children}
			{actions.length > 0 && (
				<div className="my-2 flex flex-wrap gap-1">
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
								onLanding={(landing) => {
									edit(only, (project) => ({...project, landing}));
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

/**
 * Repos a question names before counting the rest: at most two truncated chips per line, so the
 * sample fills at most two lines even at phone width.
 */
const SAMPLE = 4;

type Step = 1 | 2 | 3;

const STEPS: [Step, string][] = [
	[1, "Quick questions"],
	[2, "Decide the rest"],
	[3, "Save"],
];

function StepBadge({number, step}: {number: Step; step: Step}) {
	const tone =
		number < step
			? "bg-status-green text-white"
			: number === step
				? "bg-blue-600 text-white"
				: "bg-bg-300 text-text-500";
	return (
		<span
			className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${tone}`}
		>
			{number}
		</span>
	);
}

/**
 * The three steps, the current one highlighted: the page's only step navigation, so the sections
 * below carry no numbered headings and the save bar alone counts what is left to decide.
 */
function Progress({step}: {step: Step}) {
	return (
		<nav aria-label="Review progress" className="mb-4 rounded-lg border border-border-300/50 bg-bg-100 px-3 py-2">
			<ol className="flex flex-wrap items-center gap-x-4 gap-y-1">
				{STEPS.map(([number, title]) => (
					<li
						key={title}
						aria-current={number === step ? "step" : undefined}
						className={`flex items-center gap-1.5 text-sm ${
							number === step ? "font-semibold text-text-100" : "text-text-500"
						}`}
					>
						<StepBadge number={number} step={step} />
						{title}
					</li>
				))}
			</ol>
		</nav>
	);
}

/** What a step's section asks for; the step bar above names it. */
function StepHint({children}: {children: ReactNode}) {
	return <p className="mb-2 text-xs text-text-500">{children}</p>;
}

/**
 * One bulk action asked as a question: what it covers, how many, a sample of the repos, and Keep to
 * pass. Every part has a fixed height (long text clamps, its full text in a tooltip), so the card
 * keeps one size as questions advance and nothing below it reflows.
 */
function QuestionCard({
	action,
	position,
	total,
	onAnswer,
	onKeep,
}: {
	action: BulkAction;
	position: number;
	total: number;
	onAnswer: () => void;
	onKeep: () => void;
}) {
	const sample = action.names.slice(0, SAMPLE);
	const more = action.names.length - sample.length;
	return (
		<section
			aria-label="Quick question"
			className="rounded-xl border border-blue-500/40 bg-bg-000 p-4 text-xs text-text-300 shadow-sm"
		>
			<p
				data-question-count
				className="mb-1 h-4 text-[11px] leading-4 font-medium tracking-wide text-blue-600 uppercase dark:text-blue-400"
			>
				Question {position} of {total}
			</p>
			<h3 title={action.question} className="line-clamp-2 h-12 text-base leading-6 font-semibold text-text-100">
				{action.question}
			</h3>
			<p
				data-covers
				title={action.covers}
				className="mt-1 line-clamp-4 h-16 leading-4 text-text-300 md:line-clamp-3 md:h-12"
			>
				{action.covers}
			</p>
			<ul data-sample className="mt-3 flex h-[2.875rem] flex-wrap content-start gap-1.5 overflow-hidden">
				{sample.map((name) => (
					<li
						key={name}
						className="h-5 max-w-36 truncate rounded-md bg-bg-200 px-1.5 font-mono text-[11px] leading-5 text-text-300"
					>
						{name}
					</li>
				))}
			</ul>
			<p data-sample-more className="mt-1 h-4 leading-4 text-text-500">
				{more > 0 && `and ${more} more`}
			</p>
			<div className="mt-3 flex flex-nowrap items-center gap-2">
				{/* The visible text starts the accessible name, which spells out every row it decides. */}
				<button
					type="button"
					aria-label={action.label}
					onClick={onAnswer}
					className={`${primaryClass} whitespace-nowrap`}
				>
					{action.short}
				</button>
				<button type="button" onClick={onKeep} className={`${buttonClass} px-3 py-1.5 text-sm`}>
					Keep
				</button>
			</div>
		</section>
	);
}

/** A question the card can take the shape of once none are left, holding the area's height. */
const PLACEHOLDER: BulkAction = {
	key: "placeholder",
	label: "",
	short: "Skip all",
	question: "",
	covers: "",
	names: Array.from({length: SAMPLE}, (_, index) => `repo-${index}`),
	dirs: new Set(),
	kind: "skip",
	done: true,
};

const noop = () => {};

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

	/** Questions answered or kept; neither is asked again until a discard. */
	const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());

	function discard() {
		setRows(candidates);
		setDecided(new Set());
		setAsked(new Set());
		setShowDiff(false);
	}

	// New candidates (a fetch replacing a persisted list, or a save) restart the review; the
	// query's structural sharing keeps the same array while the server's answer is unchanged.
	const [shownCandidates, setShownCandidates] = useState(candidates);
	if (shownCandidates !== candidates) {
		setShownCandidates(candidates);
		discard();
	}

	// An automatic test-worktree skip is listed but not written, so it never shows up as a change.
	const currentDirs = new Set(current.map((project) => project.dir));
	const projects = rows
		.filter((row) => row.group !== "unregistered" || decided.has(row.project.dir))
		.filter((row) => !isAutomaticSkip(row) || currentDirs.has(row.project.dir))
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
	const waitingUnregistered = groupRows("unregistered").filter((row) => !decided.has(row.project.dir));
	const questions = bulkActions(waitingUnregistered, "unregistered", true).filter((action) => !asked.has(action.key));
	const [question] = questions;
	const step: Step = question ? 1 : remaining > 0 ? 2 : 3;
	const ask = (key: string) => {
		setAsked((previous) => new Set([...previous, key]));
	};

	return (
		<>
			<Progress step={step} />
			<section aria-label="Quick questions" className={`mb-6 ${clearOfSaveBar}`}>
				<StepHint>Decide whole groups of repos at once. Keep leaves a group to decide one by one.</StepHint>
				{question ? (
					<QuestionCard
						key={question.key}
						action={question}
						position={asked.size + 1}
						total={asked.size + questions.length}
						onAnswer={() => {
							edit(question.dirs, (project) => decide(project, question.kind), true);
							ask(question.key);
						}}
						onKeep={() => {
							ask(question.key);
						}}
					/>
				) : (
					// The done message over an invisible card of the same shape, so the area keeps its height.
					<div className="grid">
						<div data-question-placeholder aria-hidden="true" className="invisible col-start-1 row-start-1">
							<QuestionCard action={PLACEHOLDER} position={1} total={1} onAnswer={noop} onKeep={noop} />
						</div>
						<p className="col-start-1 row-start-1 flex items-center justify-center gap-1.5 rounded-xl border border-border-300/50 bg-bg-100 text-xs text-text-500">
							<CheckCircle className="h-4 w-4 text-status-green" />
							No quick questions left.
						</p>
					</div>
				)}
			</section>
			<section aria-label="Decide the rest" className={`mb-6 ${clearOfSaveBar}`}>
				<StepHint>
					Pick Own, Fork, Nested, or Skip for each repo. Decided repos move to their own card until you save.
				</StepHint>
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
							askedAbove={unregistered}
							edit={edit}
						>
							{unregistered && (
								<p className="mb-1 text-text-500">
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
			</section>
			<section
				aria-label="In the registry"
				className={`mt-8 border-t border-border-300/50 pt-4 ${clearOfSaveBar}`}
			>
				<h3 className="mb-1 text-sm font-semibold text-text-100">In the registry</h3>
				<p className="mb-3 text-xs text-text-500">
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
					<span data-remaining className="mr-auto text-sm text-text-100 tabular-nums">
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
						className={primaryClass}
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
