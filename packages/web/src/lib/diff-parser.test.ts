import {describe, expect, it, vi} from "vitest";

import {parseDiffFiles} from "./diff-parser";

const MODIFIED_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
 const y = 3;
`;

const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const created = true;
`;

const DELETED_FILE_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

describe("parseDiffFiles", () => {
	it("splits a multi-file diff and fetches both contents per file", async () => {
		const fetchOld = vi.fn(async (file: string) => `old ${file}`);
		const fetchNew = vi.fn(async (file: string) => `new ${file}`);

		const files = await parseDiffFiles(MODIFIED_DIFF + NEW_FILE_DIFF, {old: fetchOld, new: fetchNew});

		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			oldFileName: "src/app.ts",
			newFileName: "src/app.ts",
			oldContent: "old src/app.ts",
			newContent: "new src/app.ts",
		});
		expect(files[0]?.hunks).toContain("diff --git a/src/app.ts b/src/app.ts");
	});

	it("skips fetching old content for new files", async () => {
		const fetchOld = vi.fn(async () => "should not be called");
		const fetchNew = vi.fn(async () => "created content");

		const files = await parseDiffFiles(NEW_FILE_DIFF, {old: fetchOld, new: fetchNew});

		expect(fetchOld).not.toHaveBeenCalled();
		expect(files[0]).toMatchObject({oldContent: "", newContent: "created content"});
	});

	it("skips fetching new content for deleted files", async () => {
		const fetchOld = vi.fn(async () => "old content");
		const fetchNew = vi.fn(async () => "should not be called");

		const files = await parseDiffFiles(DELETED_FILE_DIFF, {old: fetchOld, new: fetchNew});

		expect(fetchNew).not.toHaveBeenCalled();
		expect(files[0]).toMatchObject({oldContent: "old content", newContent: ""});
	});

	it("returns an empty list for empty diff output", async () => {
		const files = await parseDiffFiles("", {old: async () => "", new: async () => ""});
		expect(files).toStrictEqual([]);
	});

	it("ignores chunks without a diff header", async () => {
		const files = await parseDiffFiles("not a diff at all\n", {old: async () => "", new: async () => ""});
		expect(files).toStrictEqual([]);
	});
});
