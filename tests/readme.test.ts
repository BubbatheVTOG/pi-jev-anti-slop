import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECK_DEFINITIONS, DIMENSIONS } from "../extension/types.ts";

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

test("README documents every jev_review input and bounded defaults", () => {
  for (const input of [
    "reviewType",
    "path",
    "paths",
    "directory",
    "extensions",
    "maxFiles",
    "code",
    "language",
    "note",
    "sections",
  ]) {
    assert.ok(readme.includes(`\`${input}\``), `README is missing ${input}`);
  }
  assert.match(readme, /default.*50/i);
  assert.match(readme, /maximum 200/i);
  assert.match(readme, /80,000 characters/);
  assert.match(readme, /32k context/);
});

test("README documents activation without stale key-gate claims", () => {
  assert.match(readme, /jev\.disable.*registration gate/i);
  assert.doesNotMatch(readme, /no key.*register nothing/i);
  assert.doesNotMatch(readme, /key is the gate/i);
});

test("README documents the 1-10 scale, typed command, and prose review", () => {
  assert.match(readme, /1 \(worst\) to 10 \(best\)/);
  assert.match(readme, /\/jev review <review-type> <file-or-directory>/);
  assert.match(readme, /\/jev review prose docs/);
  assert.match(readme, /jev_review\(reviewType: "prose", directory: "docs"\)/);
  assert.match(readme, /structured per-file reports/i);
  assert.match(readme, /grammar, usage, mechanics, cadence/i);
});
