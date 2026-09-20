import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getJevArgumentCompletions,
  parseReviewArguments,
  sanitizeReviewNote,
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
      sections: false,
    },
  );
  assert.deepEqual(parseReviewArguments(["review", "src/index.ts"]), {
    reviewType: "all",
    path: "src/index.ts",
    language: undefined,
    note: "",
    sections: false,
  });
  assert.match(
    parseReviewArguments(["review", "securty", "src"]).error ?? "",
    /unknown review type.*security/,
  );
});

test("/jev redacts credentials from notes before external review", () => {
  const secret = "sk-1234567890abcdefghijklmnop";
  const sanitized = sanitizeReviewNote(`investigate token=${secret}`);

  assert.doesNotMatch(sanitized, new RegExp(secret));
  assert.match(sanitized, /credentials redacted from review note/i);
  assert.match(sanitized, /token=\[REDACTED\]/);
  assert.equal(
    sanitizeReviewNote("focus on error handling"),
    "focus on error handling",
  );
});

test("/jev parses --sections as a standalone flag on typed and legacy forms", () => {
  const typed = parseReviewArguments([
    "review",
    "prose",
    "docs/guide.md",
    "--sections",
  ]);
  assert.deepEqual(typed, {
    reviewType: "prose",
    path: "docs/guide.md",
    language: undefined,
    note: "",
    sections: true,
  });
  const legacy = parseReviewArguments([
    "review",
    "docs/guide.md",
    "--sections",
  ]);
  assert.deepEqual(legacy, {
    reviewType: "all",
    path: "docs/guide.md",
    language: undefined,
    note: "",
    sections: true,
  });
  // A bare `--sections` without a path is not a second positional: the
  // legacy two-positional error must not fire because of it.
  assert.equal(parseReviewArguments(["review", "--sections"]).error, undefined);
});
