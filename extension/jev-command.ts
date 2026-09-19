import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey, keyMasked } from "./availability.ts";
import type { JevConfig } from "./config.ts";
import { composeReport, renderForLLM } from "./compose.ts";
import { runReview } from "./review.ts";

/**
 * The human-invoked side: `/jev review <path>` and `/jev status`. Shares the exact
 * same core (runReview + composeReport) as the jev_review tool — no second
 * implementation to drift.
 */

const USAGE = "usage: /jev review <path> [--lang <lang>] [--note <text>]   |   /jev status";

export function registerJevCommand(
  pi: ExtensionAPI,
  client: TypeSafeClient,
  getConfig: (cwd: string, projectTrusted: boolean) => JevConfig,
): void {
  pi.registerCommand("jev", {
    description: "TypeSafe Jev code review: /jev review <path> | /jev status",
    handler: async (args, ctx) => {
      const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();

      if (sub === "status" || sub === "help" || sub === "") {
        const lines = [
          "jev status:",
          `  TYPESAFE_API_KEY     ${keyMasked()}`,
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
        return;
      }

      if (sub !== "review") {
        ctx.ui.notify(`jev: unknown subcommand "${sub}". ${USAGE}`, "warning");
        return;
      }

      if (!hasKey()) {
        ctx.ui.notify(
          "jev: TYPESAFE_API_KEY is not set. Export it and /reload (or start a fresh session), then retry.",
          "warning",
        );
        return;
      }

      const pathArg = parts[1];
      if (!pathArg) {
        ctx.ui.notify(`jev: missing <path>. ${USAGE}`, "warning");
        return;
      }
      const p = isAbsolute(pathArg) ? pathArg : resolve(ctx.cwd, pathArg);
      if (!existsSync(p)) {
        ctx.ui.notify(`jev: file not found: ${p}`, "error");
        return;
      }

      // Minimal --lang / --note parsing (value follows the flag).
      let language: string | undefined;
      let note = "";
      for (let i = 2; i < parts.length; i++) {
        if (parts[i] === "--lang" && parts[i + 1]) language = parts[++i];
        else if (parts[i] === "--note" && parts[i + 1]) note = parts[++i];
      }

      const code = readFileSync(p, "utf8");
      ctx.ui.notify(`jev: reviewing ${p} — calling TypeSafe (this can take a few seconds)…`, "info");
      try {
        const raw = await runReview(client, { path: p, language: language ?? "unknown", note, code });
        const report = composeReport(raw, cfg, p);
        ctx.ui.notify(renderForLLM(report), "info");
      } catch (e) {
        ctx.ui.notify(`jev: review failed — ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
