import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Review policy: the thresholds and weights that turn raw Jev judgments into a
 * verdict + flag list. This is the ONLY place policy lives (docs: "keep policy
 * explicit and raw judgments reusable" — change a number here without re-calling
 * the API).
 *
 * Every number below is a STARTING POINT to tune on real data. The docs are
 * explicit that cookbook thresholds are examples to evaluate, not universal
 * rules or permanent model limits. Jev is a trained, calibrated decision model,
 * not a guarantee — validate on your target domain.
 *
 * Precedence mirrors the cloud/voice toggles (house style): defaults, then the
 * global `~/.pi/agent/settings.json` `jev` block, then a trusted project's
 * `.pi/settings.json` `jev` block (highest). Unknown/invalid keys are ignored.
 */

export interface JevConfig {
  /** Per-dimension weight in the composite (renormalized to sum 1 in code). */
  dimensionWeights: Record<string, number>;
  /** A quality dimension scoring below this (0..1) is flagged. */
  dimensionFlagBelow: number;
  /** Below this confidence, a flagged dimension is "uncertain" (escalate, don't hard-flag). */
  confidenceFloor: number;
  /** P(yes) at/above which a bug signal routes to review. */
  bugReviewThreshold: number;
  /** P(yes) at/above which a bug signal routes to block (must fix). */
  bugBlockThreshold: number;
  /** Composite below this (0..1) → review; below the lower → block. */
  compositeReviewBelow: number;
  compositeBlockBelow: number;
  /** Scales how strongly the worst bug probability drags the composite down. */
  bugPenaltyWeight: number;
}

export const DEFAULTS: JevConfig = {
  dimensionWeights: {
    readability: 1.0,
    maintainability: 1.2,
    extensibility: 0.8,
    testability: 1.2,
    cleanliness: 0.8,
  },
  dimensionFlagBelow: 0.5,
  confidenceFloor: 0.5,
  bugReviewThreshold: 0.5,
  bugBlockThreshold: 0.85,
  compositeReviewBelow: 0.6,
  compositeBlockBelow: 0.4,
  bugPenaltyWeight: 2.0,
};

// ── I/O-boundary decoders: one per key; unknown in → validated or ignored ────

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isNumMap = (v: unknown): v is Record<string, number> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every(isNum);

function readBlock(path: string): Partial<JevConfig> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as { jev?: unknown };
    return (raw.jev ?? {}) as Partial<JevConfig>;
  } catch {
    return {};
  }
}

export function resolveConfig(input: {
  cwd: string;
  homeDir?: string;
  projectTrusted?: boolean;
}): JevConfig {
  const home = input.homeDir ?? homedir();
  const config: JevConfig = structuredClone(DEFAULTS);

  // defaults → global → (trusted) project. Later layers override.
  const layers: Partial<JevConfig>[] = [
    readBlock(join(home, ".pi", "agent", "settings.json")),
    ...(input.projectTrusted === false
      ? []
      : [readBlock(join(input.cwd, ".pi", "settings.json"))]),
  ];
  for (const raw of layers) {
    if (isNumMap(raw.dimensionWeights))
      config.dimensionWeights = {
        ...config.dimensionWeights,
        ...raw.dimensionWeights,
      };
    if (isNum(raw.dimensionFlagBelow))
      config.dimensionFlagBelow = raw.dimensionFlagBelow;
    if (isNum(raw.confidenceFloor))
      config.confidenceFloor = raw.confidenceFloor;
    if (isNum(raw.bugReviewThreshold))
      config.bugReviewThreshold = raw.bugReviewThreshold;
    if (isNum(raw.bugBlockThreshold))
      config.bugBlockThreshold = raw.bugBlockThreshold;
    if (isNum(raw.compositeReviewBelow))
      config.compositeReviewBelow = raw.compositeReviewBelow;
    if (isNum(raw.compositeBlockBelow))
      config.compositeBlockBelow = raw.compositeBlockBelow;
    if (isNum(raw.bugPenaltyWeight))
      config.bugPenaltyWeight = raw.bugPenaltyWeight;
  }
  return config;
}
