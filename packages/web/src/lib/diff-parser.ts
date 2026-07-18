/**
 * Shared parser for raw `git diff`/`git show` output. Splits the diff into
 * per-file chunks and resolves old/new file contents through injected
 * fetchers, so commit diffs and working-tree diffs (whose content refs differ)
 * share one parsing implementation instead of two drifting copies.
 */

export interface FileDiff {
	oldFileName: string;
	newFileName: string;
	/** Full diff chunk including the `diff --git` header — @git-diff-view/core needs it. */
	hunks: string;
	oldContent: string;
	newContent: string;
}

export interface DiffContentFetchers {
	/** Resolve a file's pre-change content; return "" on failure. */
	old: (fileName: string) => Promise<string>;
	/** Resolve a file's post-change content; return "" on failure. */
	new: (fileName: string) => Promise<string>;
}

export async function parseDiffFiles(rawDiff: string, fetch: DiffContentFetchers): Promise<FileDiff[]> {
	const chunks = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

	const files: FileDiff[] = [];
	for (const chunk of chunks) {
		const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*)/m);
		if (!headerMatch) continue;
		const oldFileName = headerMatch[1] ?? "";
		const newFileName = headerMatch[2] ?? "";

		// Detect new/deleted files from --- and +++ lines to avoid fetching nonexistent content
		const isNewFile = /^--- \/dev\/null$/m.test(chunk);
		const isDeletedFile = /^\+\+\+ \/dev\/null$/m.test(chunk);

		const [oldContent, newContent] = await Promise.all([
			isNewFile ? "" : fetch.old(oldFileName),
			isDeletedFile ? "" : fetch.new(newFileName),
		]);

		files.push({oldFileName, newFileName, hunks: chunk, oldContent, newContent});
	}
	return files;
}
