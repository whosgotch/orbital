import { describe, expect, it } from "vitest";
import { findFocusFile, parseUnifiedDiff } from "./DiffView";

const modifiedDiff = `diff --git a/src/main.ts b/src/main.ts
index 1111111..2222222 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const name = "orbital";
+const name = "orbital-app";
 export default a;
`;

describe("parseUnifiedDiff", () => {
  it("parses a modified file with counts and line numbers", () => {
    const [file] = parseUnifiedDiff(modifiedDiff);
    expect(file.path).toBe("src/main.ts");
    expect(file.change).toBe("modified");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);

    // The trailing newline in the diff yields a final empty context line.
    const kinds = file.lines.map((line) => line.kind);
    expect(kinds).toEqual(["hunk", "context", "del", "add", "context", "context"]);

    const del = file.lines.find((line) => line.kind === "del")!;
    const add = file.lines.find((line) => line.kind === "add")!;
    expect(del.oldNo).toBe(2);
    expect(add.newNo).toBe(2);
  });

  it("detects added and deleted files", () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-goodbye
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => [file.path, file.change])).toEqual([
      ["new.txt", "added"],
      ["old.txt", "deleted"],
    ]);
    expect(files[0].additions).toBe(1);
    expect(files[1].deletions).toBe(1);
  });

  it("returns no files for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("treats a pure rename (no content change) as one file at the new path", () => {
    const diff = `diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new.txt");
    expect(files[0].change).toBe("modified");
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
    // No hunks at all for a content-free rename — just the trailing-newline
    // artifact context line, same quirk noted on the modified-file test above.
    expect(files[0].lines.map((line) => line.kind)).toEqual(["context"]);
  });

  it("keeps a rename-with-edit's diff --git header as the section boundary against the next file", () => {
    const diff = `diff --git a/old.txt b/new.txt
similarity index 90%
rename from old.txt
rename to new.txt
index 1111111..2222222 100644
--- a/old.txt
+++ b/new.txt
@@ -1,1 +1,1 @@
-hello
+hello world
diff --git a/other.txt b/other.txt
index 3333333..4444444 100644
--- a/other.txt
+++ b/other.txt
@@ -1,1 +1,1 @@
-foo
+bar
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual(["new.txt", "other.txt"]);
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    expect(files[1].additions).toBe(1);
    expect(files[1].deletions).toBe(1);
  });
});

describe("findFocusFile", () => {
  const files = parseUnifiedDiff(modifiedDiff);

  it("returns undefined when there is no focus path", () => {
    expect(findFocusFile(files, undefined)).toBeUndefined();
  });

  it("matches an exact path", () => {
    expect(findFocusFile(files, "src/main.ts")?.path).toBe("src/main.ts");
  });

  it("matches when the focus path is a suffix of the file path", () => {
    expect(findFocusFile(files, "main.ts")?.path).toBe("src/main.ts");
  });

  it("returns undefined when nothing matches", () => {
    expect(findFocusFile(files, "unrelated.ts")).toBeUndefined();
  });
});
