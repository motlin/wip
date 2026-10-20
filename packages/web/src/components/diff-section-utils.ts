/**
 * Approximate line height used to reserve space for a file diff before it
 * becomes visible. Tuned to match `@git-diff-view/react`'s 12px font rendering.
 */
const APPROX_LINE_HEIGHT_PX = 20;
/** Minimum placeholder height so tiny diffs still register an intersection. */
const MIN_PLACEHOLDER_HEIGHT_PX = 120;
/** Cap the placeholder so very large files don't blow out the scroll area. */
const MAX_PLACEHOLDER_HEIGHT_PX = 4000;

/** Estimate the rendered height of a diff section from its hunk text. */
export function estimatePlaceholderHeight(hunks: string): number {
	const newlineCount = (hunks.match(/\n/g) ?? []).length;
	const estimated = newlineCount * APPROX_LINE_HEIGHT_PX;
	return Math.max(MIN_PLACEHOLDER_HEIGHT_PX, Math.min(estimated, MAX_PLACEHOLDER_HEIGHT_PX));
}

/** Map of file extensions to shiki language identifiers supported by @git-diff-view/shiki's default highlighter. */
const SUPPORTED_LANGS = new Set([
	"cpp",
	"java",
	"javascript",
	"css",
	"cs",
	"c",
	"vue",
	"astro",
	"bash",
	"make",
	"markdown",
	"makefile",
	"bat",
	"cmake",
	"cmd",
	"csv",
	"docker",
	"dockerfile",
	"go",
	"python",
	"html",
	"jsx",
	"tsx",
	"typescript",
	"sql",
	"xml",
	"sass",
	"ssh-config",
	"kotlin",
	"json",
	"swift",
	"txt",
	"diff",
]);

/** Common file extensions mapped to their shiki language identifier. */
const EXT_TO_LANG: Record<string, string> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	zsh: "bash",
	yml: "yaml",
	yaml: "yaml",
	md: "markdown",
	mdx: "markdown",
	htm: "html",
	kt: "kotlin",
	kts: "kotlin",
	h: "c",
	hpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	Makefile: "makefile",
	Dockerfile: "dockerfile",
};

export function resolveLanguage(fileName: string): string {
	const ext = fileName.split(".").pop() ?? "";
	const mapped = EXT_TO_LANG[ext] ?? ext;
	return SUPPORTED_LANGS.has(mapped) ? mapped : "txt";
}
