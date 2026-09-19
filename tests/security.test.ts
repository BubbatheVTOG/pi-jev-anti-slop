import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keyMasked } from "../extension/availability.ts";
import { DEFAULTS, resolveConfig } from "../extension/config.ts";
import { resolveSafeReviewPath } from "../extension/path-policy.ts";

test("API-key status never reveals key material", () => {
  const key = "abcd-super-secret-wxyz";
  const marker = keyMasked({ TYPESAFE_API_KEY: key });
  assert.equal(marker, "set");
  assert.ok(!marker.includes("abcd"));
  assert.ok(!marker.includes("wxyz"));
  assert.ok(!marker.includes(String(key.length)));
});

test("review paths stay inside the project and reject sensitive files", () => {
  const parent = mkdtempSync(join(tmpdir(), "jev-path-"));
  const root = join(parent, "project");
  mkdirSync(root);
  writeFileSync(join(root, "safe.ts"), "export const safe = true;\n");
  writeFileSync(join(root, ".env"), "SECRET=value\n");
  writeFileSync(join(parent, "outside.ts"), "export const outside = true;\n");
  symlinkSync(join(parent, "outside.ts"), join(root, "escape.ts"));
  try {
    assert.equal(
      resolveSafeReviewPath(root, "safe.ts", "file"),
      join(root, "safe.ts"),
    );
    assert.throws(
      () => resolveSafeReviewPath(root, ".env", "file"),
      /sensitive/,
    );
    assert.throws(
      () => resolveSafeReviewPath(root, "../outside.ts", "file"),
      /outside/,
    );
    assert.throws(
      () => resolveSafeReviewPath(root, "escape.ts", "file"),
      /outside/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("malformed configuration fails visibly instead of reporting defaults", () => {
  const parent = mkdtempSync(join(tmpdir(), "jev-malformed-"));
  const project = join(parent, "project");
  const home = join(parent, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), "{ not-json");
  try {
    assert.throws(
      () => resolveConfig({ cwd: project, homeDir: home }),
      /could not read Jev configuration/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("non-object Jev configuration fails visibly", () => {
  const parent = mkdtempSync(join(tmpdir(), "jev-shape-"));
  const project = join(parent, "project");
  const home = join(parent, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({ jev: "invalid" }),
  );
  try {
    assert.throws(
      () => resolveConfig({ cwd: project, homeDir: home }),
      /must be an object/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("invalid configuration values cannot escape policy ranges", () => {
  const parent = mkdtempSync(join(tmpdir(), "jev-config-"));
  const project = join(parent, "project");
  const home = join(parent, "home");
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(project, ".pi", "settings.json"),
    JSON.stringify({
      jev: {
        dimensionFlagBelow: 5,
        bugReviewThreshold: -1,
        bugBlockThreshold: 0.2,
        bugPenaltyWeight: -3,
        dimensionWeights: { readability: -2 },
      },
    }),
  );
  try {
    const config = resolveConfig({ cwd: project, homeDir: home });
    assert.equal(config.dimensionFlagBelow, DEFAULTS.dimensionFlagBelow);
    assert.equal(config.bugReviewThreshold, DEFAULTS.bugReviewThreshold);
    assert.equal(config.bugBlockThreshold, DEFAULTS.bugReviewThreshold);
    assert.equal(config.bugPenaltyWeight, DEFAULTS.bugPenaltyWeight);
    assert.equal(
      config.dimensionWeights.readability,
      DEFAULTS.dimensionWeights.readability,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
