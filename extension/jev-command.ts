import { statSync } from "node:fs";
import { extname } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey, keyMasked } from "./availability.ts";
import type { JevConfig } from "./config.ts";
import { composeReport, renderForLLM } from "./compose.ts";
import { resolveTargets, runSectionReviews } from "./jev-tool.ts";
import { runReview } from "./review.ts";
import { redactLikelySecrets, resolveSafeReviewPath } from "./path-policy.ts";
import { REVIEW_TYPES, type ReviewType } from "./types.ts";

/** Human-invoked Jev reviews. Shares review, composition, and target selection with the tool. */

const COMMAND_MAX_FILES = 50;
const PROSE_EXTENSIONS = [".md", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc"];
const REVIEW_TYPE_SET = new Set<string>(REVIEW_TYPES);
const REVIEW_TYPE_DESCRIPTIONS: Record<ReviewType, string> = {
  all: "All quality dimensions and targeted issue checks",
  quality: "Scored quality dimensions only",
  correctness: "Returns, boundaries, semantics, and concurrency",
  completeness: "Stubs, placeholders, and unfinished paths",
  contracts: "Types, APIs, schemas, and external-data validation",
  errors: "Failure handling, misleading success, and resource cleanup",
  security: "Injection, authorization, secrets, crypto, and transport",
  memory: "Unbounded growth, retained references, and materialization",
  performance: "Complexity, repeated work, blocking, and serialization",
  prose: "Style, accuracy, grammar, usage, mechanics, prose, and cadence",
  design: "Speculative abstraction and useless indirection",
};
const USAGE =
  "usage: /jev review <review-type> <file-or-directory> [--lang <lang>] [--note <text>] [--sections]   |   /jev status";

type ResolvedSelection = ReturnType<typeof resolveTargets>;
type ConfigLoader = (cwd: string, projectTrusted: boolean) => JevConfig;

export function sanitizeReviewNote(note: string): string {
  const sanitized = redactLikelySecrets(note);
  return sanitized.redacted
    ? `[credentials redacted from review note] ${sanitized.code}`
    : sanitized.code;
}

export function getJevArgumentCompletions(prefix: string): Array<{
  value: string;
  label: string;
  description?: string;
}> | null {
  const input = prefix.trimStart();
  const reviewMatch = input.match(/^review(?:\s+([^\s]*))?$/);
  if (reviewMatch) {
    const typePrefix = (reviewMatch[1] ?? "").toLowerCase();
    const matches = REVIEW_TYPES.filter((type) => type.startsWith(typePrefix));
    if (matches.length === 0) return null;
    return matches.map((type) => ({
      value: `review ${type}`,
      label: type,
      description: REVIEW_TYPE_DESCRIPTIONS[type],
    }));
  }

  if (input.includes(" ")) return null;
  const subcommands = ["review", "status"].filter((value) =>
    value.startsWith(input.toLowerCase()),
  );
  return subcommands.length === 0
    ? null
    : subcommands.map((value) => ({ value, label: value }));
}

export function parseReviewArguments(parts: string[]): {
  reviewType: ReviewType;
  path?: string;
  language?: string;
  note: string;
  sections: boolean;
  error?: string;
} {
  const candidate = (parts[1] ?? "").toLowerCase();
  const hasReviewType = REVIEW_TYPE_SET.has(candidate);
  const hasSecondPositional = Boolean(parts[2] && !parts[2]?.startsWith("--"));
  if (!hasReviewType && hasSecondPositional) {
    return {
      reviewType: "all",
      note: "",
      sections: false,
      error: `unknown review type "${candidate}"; expected one of: ${REVIEW_TYPES.join(", ")}`,
    };
  }
  const reviewType = hasReviewType ? (candidate as ReviewType) : "all";
  const pathIndex = hasReviewType ? 2 : 1;
  const path = parts[pathIndex];
  let language: string | undefined;
  let note = "";
  let sections = false;
  for (let i = pathIndex + 1; i < parts.length; i++) {
    if (parts[i] === "--lang" && parts[i + 1]) language = parts[++i];
    else if (parts[i] === "--note" && parts[i + 1]) note = parts[++i];
    else if (parts[i] === "--sections") sections = true;
  }
  return { reviewType, path, language, note, sections };
}

function notifyStatus(ctx: ExtensionCommandContext, cfg: JevConfig): void {
  const lines = [
    "jev status:",
    `  disabled             ${cfg.disable}`,
    `  TYPESAFE_API_KEY     ${keyMasked()}`,
    `  reviewTypes          ${REVIEW_TYPES.join(", ")}`,
    `  scoreRange           1–10`,
    `  compositeBlockBelow  ${cfg.compositeBlockBelow}`,
    `  compositeReviewBelow ${cfg.compositeReviewBelow}`,
    `  bugBlockThreshold    ${cfg.bugBlockThreshold}`,
    `  bugReviewThreshold   ${cfg.bugReviewThreshold}`,
    `  dimensionFlagBelow   ${cfg.dimensionFlagBelow}`,
    `  confidenceFloor      ${cfg.confidenceFloor}`,
    `  bugPenaltyWeight     ${cfg.bugPenaltyWeight}`,
    "",
    USAGE,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

export function selectReviewTargets(
  cwd: string,
  inputPath: string,
  reviewType: ReviewType,
): ResolvedSelection {
  const resolved = resolveSafeReviewPath(cwd, inputPath, "either");
  if (!resolved.ok) {
    return { targets: [], selectionError: resolved.error };
  }
  try {
    if (!statSync(resolved.path).isDirectory()) {
      return resolveTargets(cwd, { path: resolved.path });
    }
    const extensions = reviewType === "prose" ? PROSE_EXTENSIONS : undefined;
    return resolveTargets(cwd, {
      directory: resolved.path,
      extensions,
      maxFiles: COMMAND_MAX_FILES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      targets: [],
      selectionError: `could not inspect review target: ${message}`,
    };
  }
}

async function runSelectedReviews(
  client: TypeSafeClient,
  cfg: JevConfig,
  ctx: ExtensionCommandContext,
  parsed: ReturnType<typeof parseReviewArguments>,
  selection: ResolvedSelection,
): Promise<void> {
  ctx.ui.notify(
    `jev: running ${parsed.reviewType} review on ${selection.targets.length} target${selection.targets.length === 1 ? "" : "s"} — calling TypeSafe…`,
    "info",
  );
  for (const target of selection.targets) {
    if (target.error || !target.code) {
      ctx.ui.notify(
        `jev: ${target.file} — ${target.error ?? "file is empty"}`,
        "error",
      );
      continue;
    }
    try {
      const sanitized = redactLikelySecrets(target.code);
      const note = sanitized.redacted
        ? `[credentials redacted before review] ${parsed.note}`
        : parsed.note;
      const raw = await runReview(
        client,
        {
          path: target.file,
          language:
            parsed.language ?? (extname(target.file).slice(1) || "unknown"),
          note: `${parsed.reviewType} review; ${note}`,
          code: sanitized.code,
        },
        parsed.reviewType,
      );
      ctx.ui.notify(renderForLLM(composeReport(raw, cfg, target.file)), "info");
    } catch (error) {
      ctx.ui.notify(
        `jev: review failed for ${target.file} — ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }
  if (selection.scanTruncated) {
    ctx.ui.notify(
      `jev: directory scan stopped at ${COMMAND_MAX_FILES} files; review the remainder separately.`,
      "warning",
    );
  }
}

async function runSectionCommand(
  client: TypeSafeClient,
  cfg: JevConfig,
  ctx: ExtensionCommandContext,
  parsed: ReturnType<typeof parseReviewArguments>,
): Promise<void> {
  const resolved = resolveSafeReviewPath(ctx.cwd, parsed.path ?? "", "file");
  if (!resolved.ok) {
    ctx.ui.notify(`jev: ${resolved.error}`, "error");
    return;
  }
  try {
    if (!statSync(resolved.path).isFile()) {
      ctx.ui.notify(
        "jev: --sections requires a single file, not a directory.",
        "warning",
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`jev: could not inspect review target: ${message}`, "error");
    return;
  }
  ctx.ui.notify(
    `jev: running ${parsed.reviewType} section review on ${resolved.path} — calling TypeSafe…`,
    "info",
  );
  try {
    const { results, skippedEmpty } = await runSectionReviews(
      client,
      cfg,
      resolved.path,
      parsed.reviewType,
      parsed.note,
      (section, index, total) => {
        ctx.ui.notify(
          `jev: section ${index + 1}/${total} — L${section.start}-${section.end}${section.heading ? ` ${section.heading}` : ""}`,
          "info",
        );
      },
    );
    const failed = results.filter((section) => !section.ok).length;
    for (const section of results) {
      if (!section.ok) {
        ctx.ui.notify(
          `jev: ${section.file} L${section.start}-${section.end} — ${section.error}`,
          "error",
        );
        continue;
      }
      ctx.ui.notify(renderForLLM(section.report), "info");
    }
    ctx.ui.notify(
      `jev: section review complete: ${results.length - failed}/${results.length} sections${failed ? `, ${failed} failed` : ""}${skippedEmpty ? ` (${skippedEmpty} blank section(s) skipped)` : ""}.`,
      "info",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `jev: section review failed for ${resolved.path} — ${message}`,
      "error",
    );
  }
}

async function handleJevCommand(
  args: string,
  ctx: ExtensionCommandContext,
  client: TypeSafeClient,
  getConfig: ConfigLoader,
): Promise<void> {
  let cfg: JevConfig;
  try {
    cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`jev: invalid configuration — ${message}`, "error");
    return;
  }

  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (parts[0] ?? "status").toLowerCase();
  if (subcommand === "status" || subcommand === "help" || subcommand === "") {
    notifyStatus(ctx, cfg);
    return;
  }
  if (subcommand !== "review") {
    ctx.ui.notify(
      `jev: unknown subcommand "${subcommand}". ${USAGE}`,
      "warning",
    );
    return;
  }
  if (cfg.disable) {
    ctx.ui.notify("jev: disabled by configuration.", "warning");
    return;
  }
  if (!hasKey()) {
    ctx.ui.notify(
      "jev: TYPESAFE_API_KEY is not set. Export it, then retry.",
      "warning",
    );
    return;
  }

  const parsed = parseReviewArguments(parts);
  if (parsed.error) {
    ctx.ui.notify(`jev: ${parsed.error}`, "warning");
    return;
  }
  if (!parsed.path) {
    ctx.ui.notify(`jev: missing <file-or-directory>. ${USAGE}`, "warning");
    return;
  }
  const safeParsed = { ...parsed, note: sanitizeReviewNote(parsed.note) };
  if (safeParsed.sections) {
    await runSectionCommand(client, cfg, ctx, safeParsed);
    return;
  }
  const selection = selectReviewTargets(
    ctx.cwd,
    parsed.path,
    parsed.reviewType,
  );
  if (selection.selectionError) {
    ctx.ui.notify(`jev: ${selection.selectionError}`, "error");
    return;
  }
  if (selection.targets.length === 0) {
    ctx.ui.notify("jev: no matching files found.", "warning");
    return;
  }
  await runSelectedReviews(client, cfg, ctx, safeParsed, selection);
}

export function registerJevCommand(
  pi: ExtensionAPI,
  client: TypeSafeClient,
  getConfig: ConfigLoader,
): void {
  pi.registerCommand("jev", {
    description:
      "TypeSafe Jev review: /jev review <review-type> <file-or-directory>",
    getArgumentCompletions: getJevArgumentCompletions,
    handler: (args, ctx) =>
      handleJevCommand(args ?? "", ctx, client, getConfig),
  });
}
