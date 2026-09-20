import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryType, TypeSafeClient } from "@typesafe-ai/sdk";
import { ReviewError, runReview } from "../extension/review.ts";
import { DIMENSIONS, SCORE_MAX } from "../extension/types.ts";

function qualityClient(score: number): TypeSafeClient {
  const answers = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      {
        type: "score",
        score,
        confidence: 0.9,
        probabilities: {},
      },
    ]),
  );
  return {
    systemOne: async () => ({ answers, model: "jev-test", usage: {} }),
  } as unknown as TypeSafeClient;
}

const state = { code: "export const value = 1;" } as EntryType;

test("runReview accepts the top of the 0-10 score range", async () => {
  const raw = await runReview(qualityClient(SCORE_MAX), state, "quality");
  assert.equal(raw.scores.readability?.score, 10);
  assert.deepEqual(raw.nouls, {});
});

test("runReview rejects scores above 10", async () => {
  await assert.rejects(
    runReview(qualityClient(SCORE_MAX + 0.01), state, "quality"),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.kind === "response" &&
      /0 to 10/.test(error.message),
  );
});
