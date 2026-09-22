import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewQuestions } from "../extension/questions.ts";
import {
  CHECK_DEFINITIONS,
  DIMENSIONS,
  SCORE_MAX,
  SCORE_RUBRIC_SIZE,
} from "../extension/types.ts";

test("quality reviews use every 1-10 score dimension and no issue checks", () => {
  const built = buildReviewQuestions("quality");
  assert.deepEqual(built.dimensionNames, [...DIMENSIONS]);
  assert.deepEqual(built.bugNames, []);
  assert.equal(SCORE_RUBRIC_SIZE, 10);
  assert.equal(SCORE_MAX, 10);
});

test("targeted review types include only checks from their category", () => {
  for (const reviewType of [
    "security",
    "memory",
    "performance",
    "prose",
  ] as const) {
    const built = buildReviewQuestions(reviewType);
    assert.deepEqual(built.dimensionNames, []);
    assert.ok(built.bugNames.length > 0);
    assert.ok(
      built.bugNames.every(
        (name) => CHECK_DEFINITIONS[name]?.category === reviewType,
      ),
    );
  }
});

test("all reviews include every score and targeted check", () => {
  const built = buildReviewQuestions("all");
  assert.deepEqual(built.dimensionNames, [...DIMENSIONS]);
  assert.deepEqual(built.bugNames, Object.keys(CHECK_DEFINITIONS));
});
