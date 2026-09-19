import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType } from "@typesafe-ai/sdk";
import { buildReviewQuestions } from "./questions.ts";
import type { RawJudgments } from "./types.ts";

/**
 * The thin SDK boundary — the ONLY module that touches @typesafe-ai/sdk at
 * runtime. It builds the review questions, sends ONE request over the shared
 * state (all questions run in parallel per docs/cookbooks/parallel_questions),
 * and reduces the typed answers to our minimal, reusable RawJudgments shape so
 * that compose.ts stays SDK-free and unit-testable without an API key.
 *
 * Freshness (docs/patterns): a review is about the code AS IT IS NOW. This reads
 * whatever `state` you hand it and never caches a prior judgment — a review loop
 * re-runs on the current code after every change.
 *
 * No `model` is passed: the client uses its default (currently "jev-latest"), so
 * we never hardcode a version that can go stale.
 */

/** Minimal structural view of a single answer (score or noul). */
type RawAnswer =
 | {
    type: "score";
    score: number;
    confidence: number;
    probabilities?: Record<string, number>;
   }
 | { type: "noul"; noul: number };

function assertProbability(value: number, label: string): number {
 if (!Number.isFinite(value) || value < 0 || value > 1) {
  throw new Error(`invalid ${label}: expected a finite value from 0 to 1`);
 }
 return value;
}

function normalizeScoreAnswer(
 answer: Extract<RawAnswer, { type: "score" }>,
 name: string,
): RawJudgments["scores"][string] {
 if (!Number.isFinite(answer.score)) {
  throw new Error(`invalid score answer for "${name}": score is not finite`);
 }
 const probabilities = Object.fromEntries(
  Object.entries(answer.probabilities ?? {}).map(([level, probability]) => [
   level,
   assertProbability(probability, `probability for ${name}.${level}`),
  ]),
 );
 return {
  score: answer.score,
  confidence: assertProbability(answer.confidence, `confidence for ${name}`),
  probabilities,
 };
}

/**
 * Run the review: one TypeSafe call over `state`, all questions in parallel.
 * Returns the raw, reusable judgments (not a report) — composition is compose.ts.
 */
export async function runReview(
 client: TypeSafeClient,
 state: EntryType,
): Promise<RawJudgments> {
 const built = buildReviewQuestions();
 const res = await client.systemOne({ state, questions: built.questions });

 // SAFETY: `client.systemOne` is typed so that `answers[name]` for a score
 // question name is a ScoreResponse (`.score/.confidence/.probabilities`) and
 // for a noul name a NoulResponse (`.noul`). We only read those exact fields
 // and validate `a.type` before touching them, so this structural cast cannot
 // mask a real type error — it only narrows the union to the shapes we use.
 const answers = res.answers as unknown as Record<string, RawAnswer>;

 const scores: RawJudgments["scores"] = {};
 for (const name of built.dimensionNames) {
  const a = answers[name];
  if (!a || a.type !== "score")
   throw new Error(`missing/invalid score answer for "${name}"`);
  scores[name] = normalizeScoreAnswer(a, name);
 }

 const nouls: Record<string, number> = {};
 for (const name of built.bugNames) {
  const a = answers[name];
  if (!a || a.type !== "noul")
   throw new Error(`missing/invalid noul answer for "${name}"`);
  nouls[name] = assertProbability(a.noul, `noul answer for ${name}`);
 }

 return { scores, nouls, model: res.model, usage: res.usage };
}
