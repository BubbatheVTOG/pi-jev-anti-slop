import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULTS } from "../extension/config.ts";
import {
  normalizeExtensions,
  resolveReviewType,
  resolveSectionTarget,
  resolveTargets,
  runSectionReviews,
} from "../extension/jev-tool.ts";
import { buildReviewQuestions } from "../extension/questions.ts";

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

    assert.deepEqual([...normalizeExtensions(undefined, "prose")].sort(), [
      ".adoc",
      ".asciidoc",
      ".md",
      ".mdx",
      ".rst",
      ".txt",
    ]);
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

function proseClient(noul: number, calls?: number[]): TypeSafeClient {
  const built = buildReviewQuestions("prose");
  const answers = Object.fromEntries(
    built.bugNames.map((name) => [name, { type: "noul", noul }]),
  );
  return {
    systemOne: async () => {
      calls?.push(1);
      return { answers, model: "jev-test", usage: {} };
    },
  } as unknown as TypeSafeClient;
}

test("sections mode validates the target matrix without a client", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-sections-"));
  try {
    const doc = join(root, "guide.md");
    writeFileSync(doc, "# Guide\n\n## One\n\nBody.\n", "utf8");
    writeFileSync(join(root, ".env"), "TOKEN=not-a-real-token\n", "utf8");

    // Not requested → nothing to validate, no error.
    assert.deepEqual(resolveSectionTarget(root, { path: "guide.md" }), {});

    // Requested → exactly one readable, non-sensitive file, nothing else.
    const ok = resolveSectionTarget(root, { path: "guide.md", sections: true });
    assert.equal(ok.file, doc);
    assert.equal(ok.error, undefined);

    assert.match(
      resolveSectionTarget(root, { sections: true }).error ?? "",
      /requires a single `path`/,
    );
    assert.match(
      resolveSectionTarget(root, {
        path: "guide.md",
        code: "chunk",
        sections: true,
      }).error ?? "",
      /cannot be combined with `code`/,
    );
    assert.match(
      resolveSectionTarget(root, {
        paths: ["guide.md"],
        sections: true,
      }).error ?? "",
      /only be combined with a single `path`/,
    );
    assert.match(
      resolveSectionTarget(root, {
        directory: ".",
        sections: true,
      }).error ?? "",
      /only be combined with a single `path`/,
    );
    assert.match(
      resolveSectionTarget(root, { path: "missing.md", sections: true }).error ?? "",
      /could not (resolve|read)/,
    );
    assert.match(
      resolveSectionTarget(root, { path: ".env", sections: true }).error ?? "",
      /sensitive file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("section reviews split on headings, keep ranges, and isolate failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-sections-"));
  try {
    const doc = join(root, "guide.md");
    const lines = [
      "# Guide",
      "",
      "Intro prose.",
      "",
      "## Alpha",
      "Alpha body.",
      "",
      "```bash",
      "## not a boundary",
      "```",
      "",
      "## Beta",
      "Beta body.",
    ];
    writeFileSync(doc, lines.join("\n") + "\n", "utf8");

    const calls: number[] = [];
    const seen: string[] = [];
    const { results, skippedEmpty } = await runSectionReviews(
      proseClient(0.1, calls),
      DEFAULTS,
      doc,
      "prose",
      "",
      (section) => seen.push(section.heading),
    );

    assert.equal(skippedEmpty, 0);
    assert.deepEqual(
      results.map((section) => ({
        start: section.start,
        end: section.end,
        heading: section.heading,
      })),
      [
        { start: 1, end: 4, heading: "" },
        { start: 5, end: 11, heading: "Alpha" },
        { start: 12, end: 14, heading: "Beta" },
      ],
    );
    assert.deepEqual(results.map((section) => section.file), [doc, doc, doc]);
    assert.equal(calls.length, 3);
    assert.deepEqual(seen, ["", "Alpha", "Beta"]);
    for (const section of results) {
      if (!section.ok) throw new Error(`expected ok section, got ${section.error}`);
      assert.equal(section.report.model, "jev-test");
      assert.ok(section.report.bugSignals.length > 0);
      assert.ok(section.report.bugSignals.every((signal) => !signal.flagged));
      assert.equal(section.report.flags.length, 0);
      assert.equal(section.report.composite.tier, "pass");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("section reviews skip blank sections and keep other sections running", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-sections-"));
  try {
    const doc = join(root, "blank.md");
    writeFileSync(doc, "   \n## Only\n\nContent.\n", "utf8");

    const { results, skippedEmpty } = await runSectionReviews(
      proseClient(0.1),
      DEFAULTS,
      doc,
      "prose",
    );

    assert.equal(skippedEmpty, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.heading, "Only");
    if (results[0]?.ok) assert.equal(results[0].report.composite.tier, "pass");
    else throw new Error(`expected ok section, got ${results[0]?.error ?? ""}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("section reviews isolate per-section request failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-sections-"));
  try {
    const doc = join(root, "flaky.md");
    writeFileSync(doc, "# Doc\n\n## One\n\nA.\n\n## Two\n\nB.\n", "utf8");

    let attempt = 0;
    const flaky: TypeSafeClient = {
      systemOne: async () => {
        attempt += 1;
        if (attempt === 2) throw new Error("second call explodes");
        const built = buildReviewQuestions("prose");
        const answers = Object.fromEntries(
          built.bugNames.map((name) => [name, { type: "noul", noul: 0.1 }]),
        );
        return { answers, model: "jev-test", usage: {} };
      },
    } as unknown as TypeSafeClient;

    const { results } = await runSectionReviews(flaky, DEFAULTS, doc, "prose");
    // "# Doc" is a non-blank intro, so three sections are reviewed: the
    // flaky second call fails only the first real section.
    assert.equal(results.length, 3);
    if (results[0]?.ok) assert.equal(results[0].report.model, "jev-test");
    else throw new Error(`intro section should succeed: ${results[0]?.error ?? ""}`);
    if (!results[1]?.ok) {
      // runReview masks third-party error text; the original failure stays
      // on the cause and never reaches the reported message.
      assert.match(results[1].error, /TypeSafe review request failed/);
    } else {
      throw new Error("the '## One' section should fail");
    }
    assert.equal(results[1]?.start, 3);
    if (results[2]?.ok) assert.equal(results[2].report.model, "jev-test");
    else throw new Error(`the '## Two' section should succeed: ${results[2]?.error ?? ""}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
