import {
  BUG_CHECKS,
  BUG_NAMES,
  DIMENSIONS,
  SCORE_MAX,
  type BugSignal,
  type Dimension,
  type DimensionAssessment,
  type Flag,
  type FlagSeverity,
  type RawJudgments,
  type ReviewReport,
  type Tier,
} from "./types.ts";
import type { JevConfig } from "./config.ts";

/**
 * Pure policy: raw Jev judgments → a verdict + an actionable flag list.
 *
 * No SDK, no I/O — this is a deterministic function of (raw, config). That keeps
 * it trivially unit-testable (tests/compose.test.ts) and means weights/thresholds
 * can change WITHOUT re-calling the API (docs: keep policy explicit and raw
 * judgments reusable; change a weight or a display filter without re-running
 * inference when the evidence and question meanings are unchanged).
 */

const clamp01 = (n: number): number => {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

/** Ordering for the work list: error first, then warning, then info. */
const SEVERITY_RANK: Record<FlagSeverity, number> = { error: 0, warning: 1, info: 2 };

/** A weight that is a positive finite number, else 0. */
const positive = (w: number | undefined): number =>
  typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 0;

export function composeReport(raw: RawJudgments, cfg: JevConfig, target?: string): ReviewReport {
  // 1) Per-dimension assessment. Normalize raw/(rubric-1) → 0..1 (1 = best).
  //    A low score is "flagged"; a flagged score WITH low confidence is "uncertain"
  //    (escalate, do not hard-flag) — confidence is distribution concentration, not
  //    correctness (docs/confidence).
  const dimensions = {} as Record<Dimension, DimensionAssessment>;
  for (const dim of DIMENSIONS) {
    const a = raw.scores[dim];
    const normalized = a ? clamp01(a.score / SCORE_MAX) : 0;
    const confidence = a ? a.confidence : 0;
    const flagged = normalized < cfg.dimensionFlagBelow;
    const uncertain = flagged && confidence < cfg.confidenceFloor;
    dimensions[dim] = {
      dimension: dim,
      raw: a?.score ?? 0,
      max: SCORE_MAX,
      normalized,
      confidence,
      probabilities: a?.probabilities ?? {},
      flagged,
      uncertain,
    };
  }

  // 2) Bug signals: threshold each independent noul (guardrails "battery" pattern).
  const bugSignals: BugSignal[] = BUG_NAMES.map((name) => {
    const probability = raw.nouls[name] ?? 0;
    const action: Tier =
      probability >= cfg.bugBlockThreshold
        ? "block"
        : probability >= cfg.bugReviewThreshold
          ? "review"
          : "pass";
    return { name, description: BUG_CHECKS[name], probability, action, flagged: action !== "pass" };
  });

  // 3) Composite health (0..1, higher = healthier): weighted quality minus a
  //    penalty scaled by the worst bug probability. Weights are renormalized in
  //    code so they sum to 1.
  const weightSum = DIMENSIONS.reduce((s, d) => s + positive(cfg.dimensionWeights[d]), 0) || 1;
  let quality = 0;
  for (const dim of DIMENSIONS) {
    quality += (positive(cfg.dimensionWeights[dim]) / weightSum) * dimensions[dim].normalized;
  }
  const worstBug = bugSignals.reduce((m, b) => Math.max(m, b.probability), 0);
  const bugPenalty = (cfg.bugPenaltyWeight / (1 + cfg.bugPenaltyWeight)) * worstBug;
  const composite = clamp01(quality - bugPenalty);

  // 4) Verdict (block > review > pass). A block-level bug forces block; any
  //    review-level bug or any uncertain dimension forces at least review. The
  //    composite alone can also push to block/review from below.
  let tier: Tier =
    composite < cfg.compositeBlockBelow
      ? "block"
      : composite < cfg.compositeReviewBelow
        ? "review"
        : "pass";
  const hasBlockBug = bugSignals.some((b) => b.action === "block");
  const hasReviewBug = bugSignals.some((b) => b.action === "review");
  const hasUncertain = Object.values(dimensions).some((d) => d.uncertain);
  if (hasBlockBug) tier = "block";
  else if (hasReviewBug || hasUncertain) tier = "review";

  const escalate = tier !== "pass";

  // 5) Flags: the main LLM's work list, ordered error → warning → info. A flag's
  //    `detail` is authored here from the judgment wording — Jev never explains.
  const flags: Flag[] = [];
  for (const b of bugSignals) {
    if (b.action === "block")
      flags.push({
        severity: "error",
        kind: "bug",
        title: `Fix: ${b.name}`,
        detail: b.description,
        confidence: b.probability,
      });
    else if (b.action === "review")
      flags.push({
        severity: "warning",
        kind: "bug",
        title: `Review: ${b.name}`,
        detail: b.description,
        confidence: b.probability,
      });
  }
  for (const dim of DIMENSIONS) {
    const d = dimensions[dim];
    if (d.uncertain) {
      flags.push({
        severity: "warning",
        kind: "uncertainty",
        title: `Low confidence on ${dim}`,
        detail:
          `Jev scored ${dim} ${d.normalized.toFixed(2)} but with low confidence ` +
          `(${d.confidence.toFixed(2)} < floor ${cfg.confidenceFloor}). Do not auto-apply a ` +
          `change from this signal — read the code and judge ${dim} yourself.`,
        confidence: d.confidence,
      });
    } else if (d.flagged) {
      flags.push({
        severity: "warning",
        kind: "dimension",
        title: `Improve: ${dim}`,
        detail:
          `${dim} scored ${d.normalized.toFixed(2)} (below the ${cfg.dimensionFlagBelow} bar). ` +
          `Read the file and improve ${dim}, targeting only concrete, observable problems — ` +
          `do not invent issues that are not in the code.`,
        confidence: d.confidence,
      });
    }
  }
  if (tier === "block") {
    flags.push({
      severity: "error",
      kind: "composite",
      title: "Overall health below block threshold",
      detail:
        `Composite ${composite.toFixed(2)} < ${cfg.compositeBlockBelow}. Expect rework ` +
        `rather than a patch; resolve the bug flags first.`,
      confidence: 1,
    });
  } else if (tier === "review") {
    flags.push({
      severity: "warning",
      kind: "composite",
      title: "Overall health below review threshold",
      detail:
        `Composite ${composite.toFixed(2)} < ${cfg.compositeReviewBelow}. Address the ` +
        `flagged items before considering this change done.`,
      confidence: 1,
    });
  }
  flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    target,
    model: raw.model,
    dimensions,
    bugSignals,
    composite: { score: composite, tier },
    escalate,
    flags,
    raw,
  };
}

/**
 * Compact, machine- and human-readable rendering of a report — the exact text the
 * main LLM consumes (tool `content`) and that `/jev review` prints. Pure and
 * deterministic, so it is covered by the same unit tests.
 */
export function renderForLLM(r: ReviewReport): string {
  const lines: string[] = [];
  lines.push(`## Jev code review — ${r.target ?? "<inline code>"}`);
  lines.push(
    `verdict: ${r.composite.tier.toUpperCase()}   ` +
      `composite health ${r.composite.score.toFixed(2)} / 1.00   ` +
      `escalate=${r.escalate}`,
  );
  lines.push("");
  lines.push(`Dimensions (0=worst → 1=best, normalized from Jev's 0–4 rubric; conf = Jev confidence):`);
  for (const dim of DIMENSIONS) {
    const d = r.dimensions[dim];
    const marks: string[] = [];
    if (d.uncertain) marks.push("LOW-CONF");
    if (d.flagged) marks.push("FLAGGED");
    const mark = marks.length ? `   <-- ${marks.join(", ")}` : "";
    lines.push(
      `  ${dim.padEnd(14)} ${d.normalized.toFixed(2).padStart(5)}  ` +
        `raw ${d.raw.toFixed(2)}/4  conf ${d.confidence.toFixed(2)}${mark}`,
    );
  }
  lines.push("");
  lines.push(`Bug signals (P(yes) the defect is present; higher = more likely a real bug):`);
  for (const b of r.bugSignals) {
    const tag = b.action === "block" ? "FIX" : b.action === "review" ? "review" : "pass";
    lines.push(`  ${b.name.padEnd(18)} P=${b.probability.toFixed(2)}  ${tag}`);
  }
  lines.push("");
  if (r.flags.length > 0) {
    lines.push(`Work list (error → warning → info); read the file and fix these before continuing:`);
    r.flags.forEach((f, i) => {
      lines.push(`  ${i + 1}. [${f.severity}] ${f.title}  (signal confidence ${f.confidence.toFixed(2)})`);
      lines.push(`       ${f.detail}`);
    });
  } else {
    lines.push(`No flags — nothing below threshold. Proceed, but still verify the change works.`);
  }
  lines.push("");
  lines.push(
    `NOTE: Jev returns judgments + probabilities, not explanations. A flag is a signal ` +
      `to look, not a confirmed defect. Verify each item in the code before changing it.`,
  );
  return lines.join("\n");
}
