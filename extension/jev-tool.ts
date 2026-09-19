import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey, keyMasked } from "./availability.ts";
import type { JevConfig } from "./config.ts";
import { composeReport, renderForLLM } from "./compose.ts";
import { runReview } from "./review.ts";

/**
 * The LLM-callable side of the reviewer: a `jev_review` tool the main agent
 * invokes in its review loop. It is the only consumer of `runReview`/`composeReport`
 * besides the /jev command; both share the same core.
 */

/** Never ship a whole large file into the model; scope to the changed hunk when possible. */
const MAX_CODE_CHARS = 200_000;

const PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Absolute or cwd-relative path to the file to review. Ignored when `code` is also provided.",
    }),
  ),
  code: Type.Optional(
    Type.String({
      description:
        "Inline code (a diff/hunk or a full file) to review. Takes precedence over `path` — in a review loop, prefer passing the changed hunk.",
    }),
  ),
  language: Type.Optional(
    Type.String({ description: "Programming language of the code (e.g. typescript). Helps Jev; optional." }),
  ),
  note: Type.Optional(
    Type.String({ description: "Context about the change (intent, constraints). Included in the state; optional." }),
  ),
});

export function registerJevReviewTool(
  pi: ExtensionAPI,
  client: TypeSafeClient,
  getConfig: (cwd: string, projectTrusted: boolean) => JevConfig,
): void {
  pi.registerTool({
    name: "jev_review",
    label: "Jev code review",
    description:
      "Run a TypeSafe Jev code review on a file or a diff and get a structured flag report to act on. " +
      "Pass a file `path` (or the changed hunk as inline `code`). It returns: per-dimension quality " +
      "scores (readability, maintainability, extensibility, testability, cleanliness), bug signals with " +
      "P(yes), an overall verdict (pass/review/block), an escalate flag, and a prioritized work list. " +
      "This is a signal to investigate, not a proof: verify each item in the code before changing it.",
    promptSnippet:
      "After writing or editing code, run jev_review on the change (file path, or the diff as `code`); " +
      "read the file and fix any flagged items, then re-run until escalate=false.",
    promptGuidelines: [
      "In your review loop, call jev_review on code you just wrote or changed before declaring it done — pass the file path, or the changed hunk as `code`.",
      "If the report shows error flags or escalate=true, read the file, fix each flagged item, and re-run jev_review to confirm the flags clear.",
      "Treat every flag as a signal to investigate, not a confirmed defect — verify it in the code before editing.",
    ],
    parameters: PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
      const result = (text: string, details: Record<string, unknown>) =>
        ({ content: [{ type: "text" as const, text }], details });

      if (!hasKey())
        return result(
          "jev_review unavailable: TYPESAFE_API_KEY is not set in this environment. " +
            "Ask the user to export it, then run /reload (a fresh session also works).",
          { ok: false, reason: "no-key" },
        );

      // Resolve the code: inline `code` wins; otherwise read `path` fresh (never cached).
      let code = typeof params.code === "string" ? params.code : "";
      let target: string | undefined;
      if (code.trim() === "" && typeof params.path === "string" && params.path.trim() !== "") {
        const p = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
        if (!existsSync(p))
          return result(`jev_review: file not found: ${p}`, { ok: false, reason: "not-found", path: p });
        code = readFileSync(p, "utf8");
        target = p;
      }
      if (code.trim() === "")
        return result(
          "jev_review: nothing to review — provide either `code` (inline) or an existing `path`.",
          { ok: false, reason: "empty" },
        );

      let truncated = false;
      if (code.length > MAX_CODE_CHARS) {
        code = code.slice(0, MAX_CODE_CHARS);
        truncated = true;
      }

      // All state values are strings (Jev accepts text only); fold truncation into `note`.
      const note =
        (truncated
          ? "[note: the file was truncated for this review; read the full file on disk] "
          : "") + (params.note ?? "");
      const state = {
        path: target ?? params.path ?? "<inline>",
        language: params.language ?? "unknown",
        note,
        code,
      };

      try {
        const raw = await runReview(client, state);
        const report = composeReport(raw, cfg, state.path);
        return result(renderForLLM(report), { ok: true, report });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return result(
          `jev_review: the TypeSafe call failed (${msg}). The automated review could not run — ` +
            `fall back to your own judgment and say the automated review was unavailable.`,
          { ok: false, reason: "api-error", error: msg, keyMasked: keyMasked() },
        );
      }
    },
  });
}
