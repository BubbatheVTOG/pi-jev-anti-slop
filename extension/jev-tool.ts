import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey } from "./availability.ts";
import type { JevConfig } from "./config.ts";
import { composeReport } from "./compose.ts";
import { runReview } from "./review.ts";
import { redactLikelySecrets, resolveSafeReviewPath } from "./path-policy.ts";
import { splitSections, type SourceSection } from "./split.ts";
import {
  REVIEW_TYPES,
  type ReviewReport,
  type ReviewType,
  type SectionReviewResult,
} from "./types.ts";

/**
 * LLM-callable code review. A request can target one file, an explicit group,
 * a directory, anonymous inline code, or a supplied chunk attributed to an
 * existing source path. Section-level mode (`sections: true` + `path`) splits
 * one file into `## `-delimited sections and gives each its own independent
 * review with line ranges in the result. Every target gets its own Jev
 * request and its result retains the exact normalized file path when one is
 * available.
 */

const MAX_CODE_CHARS = 200_000;
const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
];
const PROSE_EXTENSIONS = [".md", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc"];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "venv",
]);
const DEFAULT_MAX_FILES = 200;

const REVIEW_TYPE_SCHEMA = Type.String({
  enum: [...REVIEW_TYPES],
  description:
    "Review scope. `all` runs every score and issue check; targeted types run only their relevant questions. Defaults to `all`.",
});

const PARAMS = Type.Object({
  reviewType: Type.Optional(REVIEW_TYPE_SCHEMA),
  path: Type.Optional(
    Type.String({
      description:
        "One cwd-relative file path, or an absolute path inside the current project root. Use alone to review the whole file, or combine with `code` to attribute a supplied chunk/diff to this file. Use `paths` for an explicit group or `directory` for a codebase scan.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Explicit cwd-relative paths, or absolute paths inside the current project root. Each file is reviewed independently and returned with its exact normalized path.",
      minItems: 1,
      maxItems: DEFAULT_MAX_FILES,
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description:
        "A cwd-relative directory, or an absolute directory inside the current project root, to scan recursively. Cannot be combined with inline `code`. Defaults to common source-code extensions.",
    }),
  ),
  extensions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Extensions to include during a directory scan, such as [".ts", ".tsx"]. Defaults to common source-code extensions.',
      minItems: 1,
      maxItems: 50,
    }),
  ),
  maxFiles: Type.Optional(
    Type.Integer({
      description: `Maximum files in a directory scan; default ${DEFAULT_MAX_FILES}.`,
      minimum: 1,
      maximum: DEFAULT_MAX_FILES,
    }),
  ),
  code: Type.Optional(
    Type.String({
      description:
        "Inline code, a diff, or a cohesive chunk for one review. Combine with `path` to preserve its source filename; without `path`, the target is reported as <inline>. Cannot be combined with `paths` or `directory`.",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description:
        "Programming language of the code; optional for file and directory reviews.",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Context about the change or review constraints; optional.",
    }),
  ),
  sections: Type.Optional(
    Type.Boolean({
      description:
        "Split ONE `path` file into `## `-delimited sections and run one independent review per section, each retaining the file path, 1-based line range, and heading. Use only with `path`; cannot be combined with `code`, `paths`, or `directory`. Files without `## ` headings are reviewed as a single whole-file section.",
    }),
  ),
});

type ReviewTarget = {
  file: string;
  code: string;
  error?: string;
  suppliedChunk?: boolean;
};
type FileResult =
  | {
      file: string;
      ok: true;
      report: ReviewReport;
    }
  | {
      file: string;
      ok: false;
      error: string;
    };

export function resolveReviewType(value: string | undefined): ReviewType {
  return REVIEW_TYPES.find((reviewType) => reviewType === value) ?? "all";
}

export function normalizeExtensions(
  extensions: string[] | undefined,
  reviewType: ReviewType = "all",
): Set<string> {
  const defaults =
    reviewType === "prose" ? PROSE_EXTENSIONS : DEFAULT_EXTENSIONS;
  return new Set(
    (extensions ?? defaults).map((value) => {
      const trimmed = value.trim().toLowerCase();
      return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    }),
  );
}

function collectFiles(
  root: string,
  extensions: Set<string>,
  maxFiles: number,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
          visit(resolve(directory, entry.name));
        continue;
      }
      if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
        files.push(resolve(directory, entry.name));
      }
    }
  };
  visit(root);
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    truncated,
  };
}

function readTarget(file: string): ReviewTarget {
  try {
    if (!existsSync(file)) return { file, code: "", error: "file not found" };
    if (!statSync(file).isFile())
      return { file, code: "", error: "not a regular file" };
    const code = readFileSync(file, "utf8");
    return code.trim() === ""
      ? { file, code: "", error: "file is empty" }
      : { file, code };
  } catch (error) {
    return {
      file,
      code: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveTargets(
  cwd: string,
  params: {
    path?: string;
    paths?: string[];
    directory?: string;
    extensions?: string[];
    maxFiles?: number;
    code?: string;
    reviewType?: ReviewType;
  },
): {
  targets: ReviewTarget[];
  selectionError?: string;
  scanTruncated?: boolean;
} {
  if (typeof params.code === "string") {
    if (params.code.trim() === "") {
      return { targets: [], selectionError: "`code` must not be empty." };
    }
    if (params.paths?.length || params.directory) {
      return {
        targets: [],
        selectionError: "`code` cannot be combined with paths or directory.",
      };
    }
    if (!params.path) {
      return { targets: [{ file: "<inline>", code: params.code }] };
    }
    const resolved = resolveSafeReviewPath(cwd, params.path, "file");
    if (!resolved.ok) {
      return { targets: [], selectionError: resolved.error };
    }
    return {
      targets: [
        {
          file: resolved.path,
          code: params.code,
          suppliedChunk: true,
        },
      ],
    };
  }

  let requested: string[] = [];
  if (params.paths?.length) requested = params.paths;
  else if (params.path) requested = [params.path];

  if (requested.length > 0 && params.directory) {
    return {
      targets: [],
      selectionError: "Use either path/paths or directory, not both.",
    };
  }

  if (requested.length > 0) {
    const targets: ReviewTarget[] = [];
    for (const requestedPath of requested) {
      const resolved = resolveSafeReviewPath(cwd, requestedPath, "file");
      if (!resolved.ok) {
        return { targets: [], selectionError: resolved.error };
      }
      targets.push(readTarget(resolved.path));
    }
    return { targets };
  }

  if (params.directory) {
    const resolved = resolveSafeReviewPath(cwd, params.directory, "directory");
    if (!resolved.ok) {
      return { targets: [], selectionError: resolved.error };
    }
    const directory = resolved.path;
    const extensions = normalizeExtensions(
      params.extensions,
      params.reviewType ?? "all",
    );
    const scan = collectFiles(
      directory,
      extensions,
      params.maxFiles ?? DEFAULT_MAX_FILES,
    );
    return {
      targets: scan.files.map(readTarget),
      scanTruncated: scan.truncated,
    };
  }

  return {
    targets: [],
    selectionError: "Provide path, paths, directory, or inline code.",
  };
}

function summarizeResult(result: FileResult): string {
  if (!result.ok) return `\n## ${result.file}\nERROR: ${result.error}`;
  const report = result.report;
  return [
    `\n## ${result.file}`,
    `verdict: ${report.composite.tier.toUpperCase()}   composite=${report.composite.score.toFixed(2)}   escalate=${report.escalate}`,
    `flags: ${report.flags.length}`,
    ...report.flags.map(
      (flag, index) =>
        `  ${index + 1}. [${flag.severity}] ${flag.title} — ${flag.detail}`,
    ),
  ].join("\n");
}

/**
 * Target validation for `sections` mode: a single safe, readable file and
 * nothing else. Kept pure so the full rejection matrix is unit-testable
 * without an ExtensionAPI instance.
 */
export function resolveSectionTarget(
  cwd: string,
  params: {
    path?: string;
    paths?: string[];
    directory?: string;
    code?: string;
    sections?: boolean;
  },
): { file?: string; error?: string } {
  if (!params.sections) return {};
  if (params.code !== undefined) {
    return {
      error:
        "`sections` cannot be combined with `code`; pass the chunk in `code` for a single chunk review.",
    };
  }
  if (params.paths?.length || params.directory) {
    return { error: "`sections` can only be combined with a single `path`." };
  }
  if (!params.path) {
    return { error: "`sections` requires a single `path` to split into sections." };
  }
  const resolved = resolveSafeReviewPath(cwd, params.path, "file");
  if (!resolved.ok) return { error: resolved.error };
  const target = readTarget(resolved.path);
  if (target.error) {
    return { error: `could not read ${params.path}: ${target.error}` };
  }
  return { file: resolved.path };
}

/**
 * Section-level divide-and-conquer over one file: split into `## ` sections
 * (fence-aware; a headingless file degrades to one whole-file section), run
 * one independent review per section, and compose a report that retains the
 * file path plus the section's 1-based line range and heading. Shared by the
 * jev_review tool (`sections: true`) and the /jev command (`--sections`).
 *
 * Each section gets its own secret redaction and a scoping note that forbids
 * the model from assuming content outside the section. Blank sections are
 * skipped and counted, never sent.
 */
export async function runSectionReviews(
  client: TypeSafeClient,
  cfg: JevConfig,
  file: string,
  reviewType: ReviewType = "all",
  note = "",
  onSection?: (
    section: SourceSection,
    index: number,
    total: number,
  ) => void,
): Promise<{ results: SectionReviewResult[]; skippedEmpty: number }> {
  const target = readTarget(file);
  if (target.error || !target.code) {
    throw new Error(target.error ?? "file is empty");
  }
  const all = splitSections(target.code);
  const sections = all.filter((section) => section.code.trim() !== "");
  const results: SectionReviewResult[] = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    onSection?.(section, index, sections.length);
    const sanitized = redactLikelySecrets(section.code);
    let sectionNote =
      `section review: judge only lines ${section.start}-${section.end}` +
      (section.heading ? ` ("${section.heading}")` : "") +
      ` of ${file}; do not assume content outside this section; ` +
      note;
    if (sanitized.redacted) {
      sectionNote = `[credentials redacted before review] ${sectionNote}`;
    }
    try {
      const raw = await runReview(
        client,
        {
          path: file,
          language: extname(file).slice(1) || "markdown",
          note: sectionNote,
          code: sanitized.code,
        },
        reviewType,
      );
      results.push({
        file,
        start: section.start,
        end: section.end,
        heading: section.heading,
        ok: true,
        report: composeReport(raw, cfg, file),
      });
    } catch (error) {
      results.push({
        file,
        start: section.start,
        end: section.end,
        heading: section.heading,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results, skippedEmpty: all.length - sections.length };
}

function summarizeSectionResult(section: SectionReviewResult): string {
  const header = `## ${section.file}  L${section.start}-${section.end}${section.heading ? ` — ${section.heading}` : ""}`;
  if (!section.ok) return `\n${header}\nERROR: ${section.error}`;
  const report = section.report;
  return [
    `\n${header}`,
    `verdict: ${report.composite.tier.toUpperCase()}   composite=${report.composite.score.toFixed(2)}   escalate=${report.escalate}`,
    `flags: ${report.flags.length}`,
    ...report.flags.map(
      (flag, index) =>
        `  ${index + 1}. [${flag.severity}] ${flag.title} — ${flag.detail}`,
    ),
  ].join("\n");
}

export function registerJevReviewTool(
  pi: ExtensionAPI,
  client: TypeSafeClient,
  getConfig: (cwd: string, projectTrusted: boolean) => JevConfig,
): void {
  pi.registerTool({
    name: "jev_review",
    label: "Jev code review",
    description:
      "Run independent TypeSafe Jev reviews on one file, an explicit group of files, a whole codebase directory, or a named chunk from a file. " +
      "Set `reviewType` to `all`, `quality`, `correctness`, `completeness`, `contracts`, `errors`, `security`, `memory`, `performance`, `prose`, or `design`; targeted types send only relevant questions. Use `path` for one file, `paths` for exact files, `directory` for a recursive scan, or combine `path` with `code` to review a supplied chunk/diff while preserving its filename. For section-level divide-and-conquer, combine `path` with `sections: true`: the file is split on `## ` headings (fence-aware; a headingless file is one whole-file section) and each section gets its own independent review whose result retains the file path, 1-based line range, and heading. Prose directory scans default to documentation extensions. Targets must remain inside the current project and sensitive credential files are rejected. Every result includes the exact normalized file path, verdict, composite score, per-file flags, and isolated errors. " +
      "This is a signal to investigate, not proof: verify each item in the supplied material before changing it.",
    promptSnippet:
      "Run jev_review with a targeted reviewType when appropriate. Directory batches return structured per-file results; for divide-and-conquer searches, pass a filename in `path` with a cohesive chunk in `code`, or `path` with `sections: true` for one review per `## ` section with line ranges.",
    promptGuidelines: [
      "Set jev_review `reviewType` to the narrowest relevant scope; use `all` only when the task needs every score and issue category.",
      "Use `path` for one whole file, `paths` for an explicit group, or `directory` to review a whole codebase recursively. Directory results persist structured per-file reports and isolated errors in tool details.",
      "For large files, prefer `sections: true` with `path` to localize issues: each flagged section carries the file, 1-based line range, and heading. Verify every flagged section against the full file before editing, and do not claim the file is clean until every section and its boundaries have been checked.",
      "For a large file or a targeted bug search, divide it into cohesive, preferably overlapping chunks and call `jev_review` with the same `path` plus each chunk in `code`. Track coverage, investigate each flag against the full file, and do not claim the file is clean until all relevant chunks and their boundaries have been checked.",
      "Treat every returned file independently: use the exact `file` field to read and fix only that file, then re-run Jev for the changed files.",
      "A batch contains one TypeSafe request per file; do not treat a composite-only verdict as proof of a defect.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const result = (text: string, details: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details,
      });

      const reviewType = resolveReviewType(params.reviewType);

      if (!hasKey()) {
        return result(
          "jev_review unavailable: TYPESAFE_API_KEY is not set in this environment. Ask the user to export it, then run /reload.",
          { ok: false, reason: "no-key" },
        );
      }

      let cfg: JevConfig;
      try {
        cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(`jev_review: invalid configuration: ${message}`, {
          ok: false,
          reason: "invalid-config",
        });
      }

      let selection: ReturnType<typeof resolveTargets>;
      try {
        selection = resolveTargets(ctx.cwd, { ...params, reviewType });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(
          `jev_review: could not resolve review targets: ${message}`,
          {
            ok: false,
            reason: "target-resolution",
            error: message,
          },
        );
      }
      if (selection.selectionError) {
        return result(`jev_review: ${selection.selectionError}`, {
          ok: false,
          reason: "invalid-targets",
        });
      }
      if (selection.targets.length === 0) {
        return result("jev_review: no matching source files found.", {
          ok: false,
          reason: "no-files",
        });
      }

      const sanitizedNote = redactLikelySecrets(params.note ?? "");
      const baseNote = sanitizedNote.redacted
        ? `[credentials redacted from review note] ${sanitizedNote.code}`
        : sanitizedNote.code;

      if (params.sections) {
        const sectionTarget = resolveSectionTarget(ctx.cwd, {
          path: params.path,
          paths: params.paths,
          directory: params.directory,
          code: params.code,
          sections: true,
        });
        if (sectionTarget.error || !sectionTarget.file) {
          return result(
            `jev_review: ${sectionTarget.error ?? "could not resolve the sections target."}`,
            { ok: false, reason: "sections-target" },
          );
        }
        const file = sectionTarget.file;
        let outcome: Awaited<ReturnType<typeof runSectionReviews>>;
        try {
          outcome = await runSectionReviews(
            client,
            cfg,
            file,
            reviewType,
            baseNote,
            (section, index, total) => {
              onUpdate?.({
                content: [
                  {
                    type: "text" as const,
                    text: `Jev ${reviewType} section review: ${index + 1}/${total} — ${file} L${section.start}-${section.end}${section.heading ? ` ${section.heading}` : ""}`,
                  },
                ],
                details: {
                  reviewType,
                  mode: "sections",
                  file,
                  completed: index + 1,
                  total,
                  section: { start: section.start, end: section.end, heading: section.heading },
                },
              });
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return result(`jev_review: section review failed for ${file}: ${message}`, {
            ok: false,
            reason: "section-review",
            file,
            error: message,
          });
        }
        const failed = outcome.results.filter((section) => !section.ok).length;
        const summary = [
          `Jev ${reviewType} section review complete: ${outcome.results.length - failed}/${outcome.results.length} sections reviewed in ${file}${failed ? `, ${failed} failed` : ""}.` +
            (outcome.skippedEmpty
              ? ` (${outcome.skippedEmpty} blank section(s) skipped.)`
              : ""),
          ...outcome.results.map(summarizeSectionResult),
        ].join("\n");
        return result(summary, {
          ok: failed === 0,
          reviewType,
          mode: "sections",
          file,
          sections: outcome.results,
          skippedEmpty: outcome.skippedEmpty,
        });
      }

      const results: FileResult[] = [];
      let completed = 0;
      const updateProgress = (file: string): void => {
        completed += 1;
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: `Jev ${reviewType} review: ${completed}/${selection.targets.length} — ${file}`,
            },
          ],
          details: {
            reviewType,
            completed,
            total: selection.targets.length,
            file,
          },
        });
      };
      for (const target of selection.targets) {
        const file = target.file;
        if (target.error || !target.code) {
          results.push({
            file,
            ok: false,
            error: target.error ?? "file is empty",
          });
          updateProgress(file);
          continue;
        }
        let code = target.code;
        let note = baseNote;
        if (code.length > MAX_CODE_CHARS) {
          code = code.slice(0, MAX_CODE_CHARS);
          note = `[note: file was truncated for this review; read the full file on disk] ${note}`;
        }
        const sanitized = redactLikelySecrets(code);
        code = sanitized.code;
        if (sanitized.redacted) {
          note = `[credentials redacted before review] ${note}`;
        }
        try {
          const scope = target.suppliedChunk
            ? `chunk review: judge only the supplied chunk from ${file}; inspect surrounding code before acting on a flag; `
            : `per-file review: judge only ${file}; `;
          const raw = await runReview(
            client,
            {
              path: file,
              language:
                params.language ?? (extname(file).slice(1) || "unknown"),
              note: `${scope}${note}`,
              code,
            },
            reviewType,
          );
          results.push({
            file,
            ok: true,
            report: composeReport(raw, cfg, file),
          });
        } catch (error) {
          results.push({
            file,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        updateProgress(file);
      }

      const successful = results.filter(
        (item): item is Extract<FileResult, { ok: true }> => item.ok,
      );
      const failed = results.length - successful.length;
      const summary = [
        `Jev ${reviewType} review complete: ${successful.length}/${results.length} reviewed${failed ? `, ${failed} failed` : ""}.`,
        ...(selection.scanTruncated
          ? [
              `WARNING: directory scan reached the ${params.maxFiles ?? DEFAULT_MAX_FILES}-file cap; review the remaining files separately.`,
            ]
          : []),
        ...results.map(summarizeResult),
      ].join("\n");
      return result(summary, {
        ok: failed === 0,
        reviewType,
        mode: selection.targets.length === 1 ? "single" : "batch",
        files: results,
        scanTruncated: selection.scanTruncated ?? false,
      });
    },
  });
}
