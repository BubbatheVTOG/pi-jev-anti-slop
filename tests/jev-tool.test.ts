import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  normalizeExtensions,
  resolveReviewType,
  resolveTargets,
} from "../extension/jev-tool.ts";

test("review types are validated before execution", () => {
  assert.equal(resolveReviewType("prose"), "prose");
  assert.equal(resolveReviewType("not-a-review-type"), "all");
  assert.equal(resolveReviewType(undefined), "all");
});

test("prose directory reviews default to documentation extensions", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-prose-"));
  try {
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "guide.md"), "# Guide\n", "utf8");
    writeFileSync(join(docs, "notes.rst"), "Notes\n=====\n", "utf8");
    writeFileSync(join(docs, "code.ts"), "export {};\n", "utf8");

    assert.deepEqual(
      [...normalizeExtensions(undefined, "prose")].sort(),
      [".adoc", ".asciidoc", ".md", ".mdx", ".rst", ".txt"],
    );
    const selection = resolveTargets(root, {
      directory: "docs",
      reviewType: "prose",
    });
    assert.deepEqual(
      selection.targets.map((target) => target.file),
      [join(docs, "guide.md"), join(docs, "notes.rst")],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("path plus code reviews the supplied chunk under the normalized filename", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-chunk-"));
  try {
    const file = join(root, "large.ts");
    writeFileSync(file, "const wholeFile = true;\n", "utf8");

    const result = resolveTargets(root, {
      path: "large.ts",
      code: "function selectedChunk() { return 42; }",
    });

    assert.equal(result.selectionError, undefined);
    assert.deepEqual(result.targets, [
      {
        file,
        code: "function selectedChunk() { return 42; }",
        suppliedChunk: true,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chunk mode rejects groups, directories, and sensitive filenames", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-chunk-"));
  try {
    writeFileSync(join(root, "safe.ts"), "export {};\n", "utf8");
    writeFileSync(join(root, ".env"), "TOKEN=not-a-real-token\n", "utf8");

    assert.match(
      resolveTargets(root, {
        path: "safe.ts",
        code: "   ",
      }).selectionError ?? "",
      /must not be empty/,
    );
    assert.match(
      resolveTargets(root, {
        paths: ["safe.ts"],
        code: "export const chunk = true;",
      }).selectionError ?? "",
      /cannot be combined with paths or directory/,
    );
    assert.match(
      resolveTargets(root, {
        path: ".env",
        code: "TOKEN=not-a-real-token",
      }).selectionError ?? "",
      /sensitive file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
