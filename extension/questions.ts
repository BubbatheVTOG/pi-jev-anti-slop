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
};

function dimensionInstructions(dim: Dimension): string {
  return (
    `Review the supplied code for ${dim}. Judge ONLY the code as written — do not ` +
    `infer or assume code that is not present. Score it on the ${dim} rubric using ` +
    `concrete, observable properties of the code (naming, control flow, coupling, ` +
    `duplication, extension seams, side effects, dead code, waste). Do not invent ` +
    `problems that are not actually there.`
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
        false: "No — the code as written does not exhibit this, or the relevant code is not present.",
      },
    );
  }

  return {
    questions,
    dimensionNames: [...DIMENSIONS],
    bugNames: [...BUG_NAMES],
  };
}
