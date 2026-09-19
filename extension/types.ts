/**
 * Shared, SDK-free types + constants for the Jev reviewer.
 *
 * This file imports nothing from @typesafe-ai/sdk on purpose: it is the single
 * source of truth for the judgment vocabulary (dimensions, bug classes, rubric
 * size) that BOTH the request builder (questions.ts) and the composition policy
 * (compose.ts) read from. Keeping it dependency-free means the pure composition
 * logic is unit-testable without the SDK or an API key.
 *
 * The TypeSafe mental model (docs.typesafe.ai): Jev returns TYPED judgments and
 * probabilities — never free-text explanations. A flag's `detail` is authored
 * here (from the judgment wording); the main LLM reads the actual file and
 * writes the real fix + explanation.
 */

/** Quality dimensions, each judged by ONE `score` question over the code. */
export const DIMENSIONS = [
 "readability",
 "maintainability",
 "extensibility",
 "testability",
 "cleanliness",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Ordered rubric size for every quality dimension: 0 = worst, 4 = best.
 * `compose.ts` normalizes `score / (SIZE - 1)` into 0..1 (composite-scoring
 * pattern). If the rubric grows, this stays the single knob both sides share.
 */
export const SCORE_RUBRIC_SIZE = 5;
export const SCORE_MAX = SCORE_RUBRIC_SIZE - 1;

/**
 * High-signal, common LLM-code bug classes — ONE narrow `noul` each (the
 * guardrails "battery" pattern). The string is the exact wording asked of the
 * model AND shown in a flag, so the main LLM knows precisely what to look for.
 *
 * Deliberately small: the docs warn against over-enumerating, and these are the
 * classes most likely to appear in generated code. Each is an independent
 * judgment (one per label, per the primitives guidance).
 */
export const BUG_CHECKS: Record<string, string> = {
 missing_return:
  "Is there any function, method, or branch that can complete without returning a value that its contract (its name, its declared type, or the code that calls it) requires — i.e. it falls off the end or yields an unintended/undefined value?",
 unhandled_error:
  "Is there any fallible operation (async call, I/O, parse/de-serialization, index access, division, an external SDK call) whose failure path (throw, error, reject, exception) is never handled and would crash the process or silently produce wrong results?",
 bounds_offbyone:
  "Does any index, offset, slice, or loop boundary look like it could read or write out of range (off-by-one, empty-collection access, or a boundary that does not match the collection size)?",
 resource_leak:
  "Is any resource (file, connection, lock, subscription, timer, stream, DB transaction) acquired but not released on every control-flow path, including the error path?",
 semantic_mismatch:
  "Does any piece of logic contradict its own name, an adjacent comment, or the clear expectation of the code that calls it — a sign of a semantic/logic bug rather than a style issue?",
 race_concurrency:
  "Is there any shared mutable state, or any interleaving of asynchronous/parallel work, that could produce a race, a lost update, or data corruption?",
};
export const BUG_NAMES: string[] = Object.keys(BUG_CHECKS);

// ── judgment types (as the SDK returns them) ─────────────────────────────────

export interface RawScoreAnswer {
 /** Expected score; may fall between integer rubric levels. */
 score: number;
 /** Distribution concentration, NOT overall correctness (see docs/confidence). */
 confidence: number;
 probabilities: Record<string, number>;
}

/**
 * The raw, reusable judgments keyed by question id — the minimal slice of the
 * SDK envelope we keep. Retained so weights/thresholds can change WITHOUT
 * re-calling the API (docs: raw judgments stay reusable).
 */
export interface RawJudgments {
 scores: Record<string, RawScoreAnswer>;
 nouls: Record<string, number>;
 model: string;
 usage?: unknown;
}

// ── report types (what the main LLM reads) ───────────────────────────────────

export type Tier = "pass" | "review" | "block";
export type FlagSeverity = "info" | "warning" | "error";

export interface DimensionAssessment {
 dimension: Dimension;
 raw: number; // expected score on the 0..SCORE_MAX rubric
 max: number; // SCORE_MAX
 normalized: number; // raw / max → 0..1 (1 = best)
 confidence: number;
 probabilities: Record<string, number>;
 /** normalized below the configured floor. */
 flagged: boolean;
 /** flagged AND low confidence → do not auto-apply; a human/reasoning look is needed. */
 uncertain: boolean;
}

export interface BugSignal {
 name: string;
 /** What was checked (the noul wording) — the main LLM uses this to look. */
 description: string;
 probability: number; // P(yes)
 action: Tier; // pass | review | block, per policy
 flagged: boolean; // action !== "pass"
}

export interface Flag {
 severity: FlagSeverity;
 kind: "dimension" | "bug" | "uncertainty" | "composite";
 title: string;
 detail: string;
 /** How much to trust the signal as a real problem (model confidence where it exists). */
 confidence: number;
}

export interface ReviewReport {
 /** Path of the code under review, so the main LLM can read it. */
 target?: string;
 model: string;
 dimensions: Record<Dimension, DimensionAssessment>;
 bugSignals: BugSignal[];
 composite: { score: number; tier: Tier };
 /** true → hand the flagged items to the main LLM (or a human) to read + fix. */
 escalate: boolean;
 /** Actionable, ordered error → warning → info. The main LLM's work list. */
 flags: Flag[];
 /** Raw judgments, kept for re-scoring without re-calling the API. */
 raw: RawJudgments;
}
