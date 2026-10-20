/**
 * Returns a sorted copy of the input (code-unit order). tsconfig targets
 * es2022, so Array#toSorted is missing from the lib typings.
 */
export function sorted(values: readonly string[]): string[] {
	// eslint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy, never the caller's array
	return [...values].sort((a, b) => {
		if (a < b) return -1;
		return a > b ? 1 : 0;
	});
}
