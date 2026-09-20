import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getJevArgumentCompletions,
  parseReviewArguments,
  selectReviewTargets,
} from "../extension/jev-command.ts";

test("/jev completion lists and filters available review types", () => {
  const allTypes = getJevArgumentCompletions("review ");
  assert.ok(allTypes?.some((item) => item.value === "review quality"));
  assert.ok(allTypes?.some((item) => item.value === "review prose"));

  const security = getJevArgumentCompletions("review se");
  assert.deepEqual(
    security?.map((item) => item.value),
    ["review security"],
  );
  assert.match(security?.[0]?.description ?? "", /injection/i);
});

test("prose directory reviews select documentation and skip source files", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-command-"));
  try {
    writeFileSync(join(root, "guide.md"), "# Guide\n", "utf8");
    writeFileSync(join(root, "notes.txt"), "Useful notes.\n", "utf8");
    writeFileSync(join(root, "index.ts"), "export {};\n", "utf8");
    const selection = selectReviewTargets(root, ".", "prose");
    assert.equal(selection.selectionError, undefined);
    assert.deepEqual(
      selection.targets.map((target) => target.file),
      [join(root, "guide.md"), join(root, "notes.txt")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/jev parses typed reviews and preserves the legacy all-review form", () => {
  assert.deepEqual(
    parseReviewArguments([
      "review",
      "performance",
      "src",
      "--lang",
      "typescript",
      "--note",
      "hot-path",
    ]),
    {
      reviewType: "performance",
      path: "src",
      language: "typescript",
      note: "hot-path",
    },
  );
  assert.deepEqual(parseReviewArguments(["review", "src/index.ts"]), {
    reviewType: "all",
    path: "src/index.ts",
    language: undefined,
    note: "",
  });
  assert.match(
    parseReviewArguments(["review", "securty", "src"]).error ?? "",
    /unknown review type.*security/,
  );
});
