import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHECK_DEFINITIONS,
  DIMENSIONS,
} from "../extension/types.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README lists every scored dimension and targeted issue check", () => {
  for (const dimension of DIMENSIONS) {
    assert.ok(
      readme.includes(`\`${dimension}\``),
      `README is missing dimension ${dimension}`,
    );
  }
  for (const check of Object.keys(CHECK_DEFINITIONS)) {
    assert.ok(
      readme.includes(`\`${check}\``),
      `README is missing check ${check}`,
    );
  }
});

test("README documents filename-plus-chunk divide-and-conquer reviews", () => {
  assert.match(readme, /divide-and-conquer search strategy/i);
  assert.match(readme, /jev_review\(path: "src\/foo\.ts", code: "<chunk>"\)/);
  assert.match(readme, /cross-chunk boundary/i);
});

test("README documents the 0-10 scale, typed command, and prose review", () => {
  assert.match(readme, /0 \(worst\) to 10 \(best\)/);
  assert.match(readme, /\/jev review <review-type> <file-or-directory>/);
  assert.match(readme, /\/jev review prose docs/);
  assert.match(readme, /jev_review\(reviewType: "prose", directory: "docs"\)/);
  assert.match(readme, /structured per-file reports/i);
  assert.match(readme, /grammar, usage, mechanics, cadence/i);
});
