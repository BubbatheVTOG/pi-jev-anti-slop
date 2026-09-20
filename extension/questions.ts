import { noul, score } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import {
  BUG_CHECKS,
  BUG_NAMES,
  CHECK_DEFINITIONS,
  DIMENSIONS,
  type Dimension,
  type ReviewType,
} from "./types.ts";

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
type Rubric = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

function qualityRubric(focus: string, worst: string, best: string): Rubric {
  return [
    `0 — ${worst}`,
    `1 — Very poor ${focus}; pervasive problems make the code unsafe or exceptionally difficult to work with`,
    `2 — Poor ${focus}; major problems dominate and require substantial correction`,
    `3 — Weak ${focus}; several serious problems outweigh the limited strengths`,
    `4 — Below-average ${focus}; important weaknesses remain despite some acceptable elements`,
    `5 — Mixed ${focus}; meets a basic baseline but has material room for improvement`,
    `6 — Sound ${focus}; strengths outweigh weaknesses and the remaining issues are manageable`,
    `7 — Good ${focus}; consistently solid with only a few meaningful shortcomings`,
    `8 — Very good ${focus}; strong throughout with only minor, localized weaknesses`,
    `9 — Excellent ${focus}; near-exemplary with negligible room for practical improvement`,
    `10 — ${best}`,
  ];
}

/** 11-level rubric (0 = worst, 10 = best). */
const LEVELS: Record<Dimension, Rubric> = {
  readability: qualityRubric(
    "readability across naming, structure, and control flow",
    "Dense or un-named; a new reader cannot reliably trace the main control flow",
    "Exemplary readability; self-documenting names and obvious flow let a newcomer reason about it immediately",
  ),
  maintainability: qualityRubric(
    "maintainability across cohesion, coupling, duplication, and change isolation",
    "Fragile to change; a small modification risks widespread unrelated breakage",
    "Exemplary maintainability; clean seams and isolated concerns make changes predictably local",
  ),
  extensibility: qualityRubric(
    "extensibility and the ability to add realistic new cases without rewriting core behavior",
    "Entangled and hardcoded; realistic new cases require rewriting existing logic",
    "Exemplary extensibility; stable, justified seams make realistic new cases additive and isolated",
  ),
  testability: qualityRubric(
    "testability across isolation, side-effect boundaries, and practical test seams",
    "Monolithic and side-effect-heavy; important behavior cannot be exercised in isolation",
    "Exemplary testability; important behavior is isolated behind clear boundaries and is trivial to verify deterministically",
  ),
  cleanliness: qualityRubric(
    "cleanliness across consistency, dead code, noise, and structural discipline",
    "Dead code, inconsistency, and noise substantially obscure intent",
    "Exemplary cleanliness; consistent, disciplined, and free of distracting waste",
  ),
  reliability: qualityRubric(
    "reliability under failures, retries, edge cases, and partial operations",
    "Brittle; ordinary adverse conditions can crash, corrupt state, or produce unpredictable results",
    "Exemplary reliability; strong invariants, failure isolation, and complete recovery make behavior predictably resilient",
  ),
  security_posture: qualityRubric(
    "security posture across trust boundaries, defaults, privilege, confidentiality, and integrity",
    "Insecure boundaries or defaults expose clear and severe attack paths",
    "Exemplary defense in depth; least privilege and layered controls leave minimal practical attack surface",
  ),
  resource_efficiency: qualityRubric(
    "resource efficiency across memory, allocation, cleanup, streaming, and backpressure",
    "Unbounded or leaking; memory and other resources can grow without control",
    "Exemplary resource efficiency; lifetimes and allocations are disciplined and scaling remains predictably bounded",
  ),
  performance_scalability: qualityRubric(
    "performance scalability across complexity, latency, concurrency, batching, and hot-path work",
    "Pathological blocking or superlinear work makes realistic growth or concurrency impractical",
    "Exemplary scalability; bounded complexity and lean critical paths sustain realistic growth and concurrency",
  ),
  api_contract_clarity: qualityRubric(
    "API and contract clarity across inputs, outputs, errors, ownership, and compatibility",
    "Opaque or contradictory; callers cannot determine how to use the interface correctly",
    "Exemplary contract clarity; precise minimal interfaces make valid use obvious and evolution safe",
  ),
  observability: qualityRubric(
    "observability through actionable errors and proportionate privacy-safe logs, metrics, and traces where relevant",
    "Opaque; meaningful failures and state transitions are silent, misleading, or impossible to diagnose",
    "Exemplary observability; production behavior is easy to explain with precise signals that preserve privacy",
  ),
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
export function buildReviewQuestions(
  reviewType: ReviewType = "all",
): ReviewQuestions {
  const questions = {} as Questions;
  const dimensionNames =
    reviewType === "all" || reviewType === "quality" ? [...DIMENSIONS] : [];
  const bugNames = BUG_NAMES.filter(
    (name) =>
      reviewType === "all" || CHECK_DEFINITIONS[name]?.category === reviewType,
  );

  for (const dim of dimensionNames) {
    questions[dim] = score(dimensionInstructions(dim), LEVELS[dim]);
  }
  for (const name of bugNames) {
    questions[name] = noul(
      `Review the supplied material. Answer only about what is present. ${BUG_CHECKS[name]}`,
      {
        true: "Yes — there is a concrete, plausible instance of this in the supplied material.",
        false:
          "No — the supplied material does not exhibit this, or the relevant content is not present.",
      },
    );
  }

  return {
    questions,
    dimensionNames,
    bugNames,
  };
}
