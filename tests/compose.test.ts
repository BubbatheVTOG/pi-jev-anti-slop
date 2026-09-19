import assert from "node:assert/strict";
import { test } from "node:test";
import { composeReport, renderForLLM } from "../extension/compose.ts";
import { DEFAULTS } from "../extension/config.ts";
import { BUG_NAMES, DIMENSIONS } from "../extension/types.ts";
import type { RawJudgments } from "../extension/types.ts";

/**
 * Unit tests for the pure composition policy + renderer. No SDK, no API, no I/O —
 * these run on any machine with Node's type-stripping (Node >= 23.6). They are the
 * "representative cases" the docs ask for, exercising the verdict/escalation logic
 * with a mocked raw-judgment shape (the exact shape runReview produces).
 */

interface RawOpts {
  defaultScore: number;
  defaultConf: number;
  bugProb: number;
  /** Per-dimension override (e.g. to make one dimension fail while others pass). */
  override?: Partial<Record<string, { score: number; confidence: number }>>;
  /** Per-check probability override for focused policy tests. */
  bugOverride?: Partial<Record<string, number>>;
}

function makeRaw(opts: RawOpts): RawJudgments {
  const scores: RawJudgments["scores"] = {};
  for (const d of DIMENSIONS) {
    const o = opts.override?.[d];
    scores[d] = {
      score: o?.score ?? opts.defaultScore,
      confidence: o?.confidence ?? opts.defaultConf,
      probabilities: {},
    };
  }
  const nouls: Record<string, number> = {};
  for (const b of BUG_NAMES) nouls[b] = opts.bugOverride?.[b] ?? opts.bugProb;
  return { scores, nouls, model: "jev-test", usage: {} };
}

test("clean code → pass, no flags, escalate=false", () => {
  const report = composeReport(
    makeRaw({ defaultScore: 4, defaultConf: 0.9, bugProb: 0.05 }),
    DEFAULTS,
    "src/a.ts",
  );
  assert.equal(report.composite.tier, "pass");
  assert.equal(report.escalate, false);
  assert.deepEqual(report.flags, []);
  assert.ok(
    report.composite.score > 0.9,
    `expected high composite, got ${report.composite.score}`,
  );
});

test("a block-level bug forces block + escalate even when the dimensions look fine", () => {
  const report = composeReport(
    makeRaw({ defaultScore: 3.5, defaultConf: 0.9, bugProb: 0.9 }),
    DEFAULTS,
    "src/a.ts",
  );
  assert.equal(report.composite.tier, "block");
  assert.equal(report.escalate, true);
  assert.ok(
    report.flags.some((f) => f.severity === "error" && f.kind === "bug"),
    "expected an error bug flag",
  );
});

test("new de-slop checks preserve reports and expose actionable categories", () => {
  const report = composeReport(
    makeRaw({
      defaultScore: 4,
      defaultConf: 0.9,
      bugProb: 0,
      bugOverride: { incomplete_implementation: 0.7 },
    }),
    DEFAULTS,
    "src/a.ts",
  );
  assert.equal(report.composite.tier, "review");
  const signal = report.bugSignals.find(
    (candidate) => candidate.name === "incomplete_implementation",
  );
  assert.equal(signal?.category, "completeness");
  assert.equal(signal?.action, "review");
  assert.ok(
    report.flags.some((flag) =>
      flag.title.includes("incomplete_implementation"),
    ),
  );
  assert.match(renderForLLM(report), /\[completeness\]/);
});

test("low-confidence failing dimension → uncertainty flag, not a hard dimension flag", () => {
  // readability: 1.0/4 = 0.25 (< 0.5 flagged) with conf 0.2 (< 0.5 floor) → uncertain.
  // The other four dims stay healthy (0.875) so the composite is NOT in block —
  // this isolates the "uncertain dimension escalates to at least review" path.
  const raw = makeRaw({
    defaultScore: 3.5,
    defaultConf: 0.9,
    bugProb: 0.0,
    override: { readability: { score: 1.0, confidence: 0.2 } },
  });
  const report = composeReport(raw, DEFAULTS, "src/a.ts");
  assert.equal(report.dimensions.readability.uncertain, true);
  assert.equal(report.dimensions.readability.flagged, true);
  assert.equal(report.dimensions.maintainability.flagged, false);
  // Uncertainty is flagged; a plain dimension flag is NOT emitted for the uncertain dim.
  assert.ok(
    report.flags.some((f) => f.kind === "uncertainty"),
    "expected an uncertainty flag",
  );
  assert.ok(
    !report.flags.some((f) => f.kind === "dimension"),
    "expected no hard dimension flag",
  );
  assert.equal(report.composite.tier, "review");
  assert.equal(report.escalate, true);
});

test("composite policy changes do not escalate without a concrete finding", () => {
  // All dims 2.5/4 = 0.625 (not flagged; > 0.5), no bugs → composite 0.625.
  const raw = makeRaw({ defaultScore: 2.5, defaultConf: 0.8, bugProb: 0.0 });
  const base = composeReport(raw, DEFAULTS, "src/a.ts");
  assert.equal(base.composite.tier, "pass");
  // A stricter aggregate threshold changes the score context, not the verdict:
  // there is still no concrete bug, dimension flag, or uncertainty signal.
  const stricter = { ...DEFAULTS, compositeReviewBelow: 0.7 };
  const again = composeReport(raw, stricter, "src/a.ts");
  assert.equal(again.composite.tier, "pass");
  assert.equal(again.composite.contextTier, "review");
  assert.equal(again.escalate, false);
});

test("renderForLLM emits a stable, parseable work list", () => {
  const report = composeReport(
    makeRaw({ defaultScore: 1, defaultConf: 0.6, bugProb: 0.9 }),
    DEFAULTS,
    "src/a.ts",
  );
  const text = renderForLLM(report);
  assert.match(text, /## Jev code review/);
  assert.ok(text.includes("src/a.ts"));
  assert.match(text, /verdict: BLOCK/);
  assert.match(text, /escalate=true/);
  assert.match(text, /Work list/);
  // Bug flag text is the authored judgment wording, not model prose.
  assert.ok(text.includes("unhandled_error"));
});
