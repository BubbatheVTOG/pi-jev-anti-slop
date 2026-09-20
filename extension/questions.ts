import { noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { BUG_CHECKS, BUG_NAMES, DIMENSIONS, type Dimension } from "./types.ts";

/**
 * The Jev review rubric — the ONLY place the judgment wording lives.
 *
 * Grounding (docs.typesafe.ai):
 *  - /primitives + /patterns/composite-scoring — each quality dimension is ONE
 *    `score` question with an ordered rubric; code normalizes raw/(levels-1)
 *    and weights it.
 *  - /cookbooks/llm_guardrails — a battery of independent `noul`s for
 *    bug classes, thresholded in code.
 *  - /cookbooks/parallel_questions — every question goes in ONE call over the
 *    same state (cheaper + faster, identical answers). All questions here share
 *    one state and run in parallel; none can see another's answer.
 *
 * The model returns judgments + probabilities only. Flag wording is authored in
 * compose.ts (from BUG_CHECKS / the rubric), never asked of the model.
 *
 * `DIMENSIONS`, `BUG_CHECKS`, `BUG_NAMES`, and the rubric size come from
 * types.ts so the request builder and the composer can never drift apart.
 */

/**
 * An ordered rubric: at least two levels, indexed from 0 (worst → best). The
 * SDK's ScoreCriteria is a min-2 tuple, so a plain `string[]` won't satisfy it;
 * type the levels as a min-2 tuple of strings instead. (score() throws at
 * runtime if criteria is not a list of >= 2 entries.)
 */
type Rubric = readonly [string, string, ...string[]];

/** 5-level rubric (0 = worst, 4 = best). Levels are concrete, self-contained. */
const LEVELS: Record<Dimension, Rubric> = {
  readability: [
    "Dense or un-named; a new reader would struggle to trace the main control flow",
    "Followable with effort; needs comments or outside knowledge to understand the main path",
    "Mostly clear for the main path; clear names, but with rough edges or surprises",
    "Clear; well-named, straightforward control flow a competent reader follows easily",
    "Exemplary; self-documenting names, obvious flow, no ambiguity, a newcomer reasons about it immediately",
  ],
  maintainability: [
    "Fragile to change; tightly coupled, duplicated, or global-state-laden; a small change risks unrelated breakage",
    "Hard to change; coupling and duplication make changes risky and scattered across the code",
    "Changeable with care; mostly cohesive and DRY, but a few tight spots or hidden assumptions",
    "Maintainable; cohesive, low duplication, clear boundaries; changes are localized and safe",
    "Highly maintainable; clean seams, isolated concerns, no hidden coupling; changes are trivially localized",
  ],
  extensibility: [
    "Cannot be extended; behavior is hardcoded or entangled; new cases require rewriting existing logic",
    "Hard to extend; adding a case touches many places or forces changes to core logic",
    "Extendable only with rework; seams exist but are weak; new cases need non-trivial refactoring",
    "Extensible; clear extension points (interfaces/strategy/config); new cases are additive",
    "Designed for extension; explicit, stable extension points; new cases are additive and isolated",
  ],
  testability: [
    "Not testable; monolithic with no seams and heavy side effects; cannot be exercised in isolation",
    "Hard to test; side effects and global state dominate; needs heavy mocking to test any behavior",
    "Testable with effort; some seams but substantial mocking and fixture setup required",
    "Testable; a pure-ish core with injectable dependencies; key behaviors can be exercised in isolation",
    "Highly testable; small pure functions, clear I/O boundaries, trivial to unit-test the important paths",
  ],
  cleanliness: [
    "Dirt; dead code, magic numbers, inconsistent style, or noise that obscures intent",
    "Messy; noticeable dead or duplicated code or inconsistent conventions; needs a cleanup pass",
    "Fair; some leftover cruft or minor inconsistency, but intent is mostly clear",
    "Clean; consistent, no dead code, sensible naming and structure",
    "Exemplary; consistent, tidy, no waste, reads as if reviewed and kept tight",
  ],
  reliability: [
    "Brittle; ordinary failures, retries, edge cases, or partial operations can crash, corrupt state, or produce unpredictable results",
    "Fragile; limited failure handling and weak invariants make common adverse conditions unsafe or inconsistent",
    "Adequate; common failures and edge cases are handled, but recovery and partial-state behavior have gaps",
    "Reliable; explicit invariants, predictable failure behavior, and safe recovery cover realistic adverse conditions",
    "Highly reliable; failure isolation, idempotency where needed, complete recovery paths, and strong invariants make behavior predictably resilient",
  ],
  security_posture: [
    "Insecure; trust boundaries, sensitive operations, or defaults expose clear and severe attack paths",
    "Weak; important validation, authorization, confidentiality, integrity, or secure-default controls are missing",
    "Baseline; obvious risks are addressed, but defense in depth or some boundary protections are incomplete",
    "Secure; trust boundaries are explicit, defaults are safe, sensitive operations are protected, and inputs are constrained",
    "Defense in depth; least privilege, layered validation, secure defaults, and careful sensitive-data handling leave minimal attack surface",
  ],
  resource_efficiency: [
    "Unbounded or leaking; memory, handles, connections, work queues, or allocations can grow without control",
    "Wasteful; frequent avoidable allocation, copying, retention, or poor lifecycle management creates significant pressure",
    "Acceptable; resources are generally released and bounded, with some avoidable materialization or allocation",
    "Efficient; ownership and cleanup are clear, memory is bounded, and large data uses appropriate streaming, batching, or backpressure",
    "Highly efficient; resource lifetimes are minimal and explicit, allocations are disciplined, and scaling behavior is predictably bounded",
  ],
  performance_scalability: [
    "Pathological; avoidable blocking or superlinear work makes realistic growth or concurrency impractical",
    "Poor; hot paths repeat expensive work or serialize independent operations, causing steep latency or throughput degradation",
    "Adequate; performance is reasonable at expected scale, though some paths will degrade under larger inputs or concurrency",
    "Scalable; algorithms, batching, concurrency, and I/O choices sustain expected growth without unnecessary hot-path work",
    "Excellent; complexity and latency are consistently bounded, critical paths are lean, and optimizations match observable workload constraints",
  ],
  api_contract_clarity: [
    "Opaque or contradictory; callers cannot determine valid inputs, outputs, errors, ownership, or compatibility expectations",
    "Confusing; implicit invariants, inconsistent naming, or surprising behavior make correct integration difficult",
    "Usable; the main contract is understandable, but edge cases, errors, mutability, or ownership remain partly implicit",
    "Clear; names, types, validation, errors, and compatibility behavior communicate an unsurprising stable contract",
    "Exemplary; precise minimal interfaces make valid use obvious, invalid states difficult, and evolution safe for callers",
  ],
  observability: [
    "Opaque; meaningful failures or state transitions are silent, misleading, or impossible to diagnose",
    "Weak; generic errors or noisy logs omit the context needed to locate and understand operational problems",
    "Basic; key failures are visible, but correlation, structured context, or health signals are incomplete where needed",
    "Observable; actionable errors and proportionate structured signals expose important state, latency, and failure transitions without leaking secrets",
    "Highly diagnosable; carefully scoped logs, metrics, traces, and error context make production behavior easy to explain while preserving privacy",
  ],
};

function dimensionInstructions(dim: Dimension): string {
  return (
    `Review the supplied code for ${dim}. Judge ONLY the code as written — do not ` +
    `infer or assume code that is not present. Score it on the ${dim} rubric using ` +
    `concrete, observable properties of the code and the dimension-specific rubric. ` +
    `Evaluate controls only where that concern is relevant to the supplied code; do ` +
    `not penalize a pure or bounded helper for lacking unrelated infrastructure. Do ` +
    `not invent problems that are not actually there.`
  );
}

export interface ReviewQuestions {
  /** The full question set — one state, many questions, one API call. */
  questions: Questions;
  dimensionNames: string[];
  bugNames: string[];
}

/** Build the review request's question set (shared state, parallel questions). */
export function buildReviewQuestions(): ReviewQuestions {
  const questions = {} as Questions;

  for (const dim of DIMENSIONS) {
    questions[dim] = score(dimensionInstructions(dim), LEVELS[dim]);
  }
  for (const name of BUG_NAMES) {
    questions[name] = noul(
      `Review the supplied code. Answer only about the code as written. ${BUG_CHECKS[name]}`,
      {
        true: "Yes — there is a concrete, plausible instance of this in the code as written.",
        false:
          "No — the code as written does not exhibit this, or the relevant code is not present.",
      },
    );
  }

  return {
    questions,
    dimensionNames: [...DIMENSIONS],
    bugNames: [...BUG_NAMES],
  };
}
