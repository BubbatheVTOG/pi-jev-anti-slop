import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey } from "./availability.ts";
import type { JevConfig } from "./config.ts";
import { composeReport } from "./compose.ts";
import { runReview } from "./review.ts";
import { resolveSafeReviewPath } from "./path-policy.ts";
import type { ReviewReport } from "./types.ts";

/**
 * LLM-callable code review. A request can target one file, an explicit group,
 * or a directory. Every discovered file gets its own independent Jev request
 * and its result retains the exact normalized file path.
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

const PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "One cwd-relative file path, or an absolute path inside the current project root. Use `paths` for an explicit group or `directory` for a codebase scan. Cannot be combined with inline `code`.",
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
        "Inline code or a diff/hunk for one review. Takes precedence over path selection and cannot be combined with a batch target.",
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
});

type ReviewTarget = { file: string; code: string; error?: string };
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

function normalizeExtensions(extensions: string[] | undefined): Set<string> {
  return new Set(
    (extensions ?? DEFAULT_EXTENSIONS).map((value) => {
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
  return { files: files.sort((left, right) => left.localeCompare(right)), truncated };
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

function resolveTargets(
  cwd: string,
  params: {
    path?: string;
    paths?: string[];
    directory?: string;
    extensions?: string[];
    maxFiles?: number;
    code?: string;
  },
): {
  targets: ReviewTarget[];
  selectionError?: string;
  scanTruncated?: boolean;
} {
  if (typeof params.code === "string" && params.code.trim() !== "") {
    if (params.path || params.paths?.length || params.directory) {
      return {
        targets: [],
        selectionError:
          "`code` cannot be combined with path, paths, or directory.",
      };
    }
    return { targets: [{ file: "<inline>", code: params.code }] };
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
      const file = resolveSafeReviewPath(cwd, requestedPath, "file");
      targets.push(readTarget(file));
    }
    return { targets };
  }

  if (params.directory) {
    const directory = resolveSafeReviewPath(cwd, params.directory, "directory");
    const extensions = normalizeExtensions(params.extensions);
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

export function registerJevReviewTool(
  pi: ExtensionAPI,
  client: TypeSafeClient,
  getConfig: (cwd: string, projectTrusted: boolean) => JevConfig,
): void {
  pi.registerTool({
    name: "jev_review",
    label: "Jev code review",
    description:
      "Run independent TypeSafe Jev reviews on one file, an explicit group of files, or a whole codebase directory. " +
      "Use `path` for one file, `paths` for exact files, or `directory` for a recursive scan. Targets must remain inside the current project and sensitive credential files are rejected. Every result includes the exact normalized file path, verdict, composite score, per-file flags, and errors are isolated to that file. " +
      "This is a signal to investigate, not proof: verify each item in the code before changing it.",
    promptSnippet:
      "Run jev_review per file after writing code; use paths for a group or directory for a codebase, then fix flags keyed by exact file path and re-run.",
    promptGuidelines: [
      "Use `path` for one file, `paths` for an explicit group, or `directory` to review a whole codebase recursively.",
      "Treat every returned file independently: use the exact `file` field to read and fix only that file, then re-run Jev for the changed files.",
      "A batch contains one TypeSafe request per file; do not treat a composite-only verdict as proof of a defect.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
      const result = (text: string, details: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text }],
        details,
      });

      if (!hasKey()) {
        return result(
          "jev_review unavailable: TYPESAFE_API_KEY is not set in this environment. Ask the user to export it, then run /reload.",
          { ok: false, reason: "no-key" },
        );
      }

      let selection: ReturnType<typeof resolveTargets>;
      try {
        selection = resolveTargets(ctx.cwd, params);
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

      const results: FileResult[] = [];
      for (const target of selection.targets) {
        const file = target.file;
        if (target.error || !target.code) {
          results.push({
            file,
            ok: false,
            error: target.error ?? "file is empty",
          });
          continue;
        }
        let code = target.code;
        let note = params.note ?? "";
        if (code.length > MAX_CODE_CHARS) {
          code = code.slice(0, MAX_CODE_CHARS);
          note = `[note: file was truncated for this review; read the full file on disk] ${note}`;
        }
        try {
          const raw = await runReview(client, {
            path: file,
            language: params.language ?? (extname(file).slice(1) || "unknown"),
            note: `per-file review: judge only ${file}; ${note}`,
            code,
          });
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
      }

      const successful = results.filter(
        (item): item is Extract<FileResult, { ok: true }> => item.ok,
      );
      const failed = results.length - successful.length;
      const summary = [
        `Jev per-file review complete: ${successful.length}/${results.length} reviewed${failed ? `, ${failed} failed` : ""}.`,
        ...(selection.scanTruncated
          ? [
              `WARNING: directory scan reached the ${params.maxFiles ?? DEFAULT_MAX_FILES}-file cap; review the remaining files separately.`,
            ]
          : []),
        ...results.map(summarizeResult),
      ].join("\n");
      return result(summary, {
        ok: failed === 0,
        mode: selection.targets.length === 1 ? "single" : "batch",
        files: results,
        scanTruncated: selection.scanTruncated ?? false,
      });
    },
  });
}
