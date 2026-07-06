import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./DiffView";

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

  it("marks only the changed middle of paired edit lines", () => {
    const [file] = parseUnifiedDiff(modifiedDiff);
    const del = file.lines.find((line) => line.kind === "del")!;
    const add = file.lines.find((line) => line.kind === "add")!;
    // Common prefix `const name = "orbital` and suffix `";` stay unmarked.
    expect(del.text.slice(del.markStart, del.markEnd)).toBe("");
    expect(add.text.slice(add.markStart, add.markEnd)).toBe("-app");
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
});
