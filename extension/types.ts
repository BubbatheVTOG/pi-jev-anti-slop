/**
 * Shared, SDK-free types + constants for the Jev reviewer.
 *
 * This file imports nothing from @typesafe-ai/sdk on purpose: it is the single
 * source of truth for the judgment vocabulary (dimensions, bug classes, rubric
 * size) that BOTH the request builder (questions.ts) and the composition policy
 * (compose.ts) read from. Keeping it dependency-free means the pure composition
 * logic is unit-testable without the SDK or an API key.
 *
 * The TypeSafe mental model (docs.typesafe.ai): Jev returns TYPED judgments and
 * probabilities — never free-text explanations. A flag's `detail` is authored
 * here (from the judgment wording); the main LLM reads the actual file and
 * writes the real fix + explanation.
 */

/** Quality dimensions, each judged by ONE `score` question over the code. */
export const DIMENSIONS = [
 "readability",
 "maintainability",
 "extensibility",
 "testability",
 "cleanliness",
 "reliability",
 "security_posture",
 "resource_efficiency",
 "performance_scalability",
 "api_contract_clarity",
 "observability",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * Ordered rubric size for every quality dimension: 0 = worst, 4 = best.
 * `compose.ts` normalizes `score / (SIZE - 1)` into 0..1 (composite-scoring
 * pattern). If the rubric grows, this stays the single knob both sides share.
 */
export const SCORE_RUBRIC_SIZE = 5;
export const SCORE_MAX = SCORE_RUBRIC_SIZE - 1;

/**
 * High-signal, common LLM-code bug classes — ONE narrow `noul` each (the
 * guardrails "battery" pattern). The string is the exact wording asked of the
 * model AND shown in a flag, so the main LLM knows precisely what to look for.
 *
 * Deliberately targeted: the docs warn against vague or overlapping checks, so
 * every class below names one independently actionable failure mode and includes
 * a relevance guard where the issue requires a particular kind of code.
 */
export const CHECK_CATEGORIES = [
 "correctness",
 "completeness",
 "contracts",
 "errors",
 "security",
 "memory",
 "performance",
 "design",
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export interface CheckDefinition {
 category: CheckCategory;
 question: string;
}

/** Narrow, independently actionable checks. Existing check names stay stable. */
export const CHECK_DEFINITIONS: Record<string, CheckDefinition> = {
 missing_return: {
  category: "correctness",
  question:
   "Is there any function, method, or branch that can complete without returning a value that its contract (its name, its declared type, or the code that calls it) requires — i.e. it falls off the end or yields an unintended/undefined value?",
 },
 unhandled_error: {
  category: "errors",
  question:
   "Is there any fallible operation (async call, I/O, parse/de-serialization, index access, division, an external SDK call) whose failure path (throw, error, reject, exception) is never handled and would crash the process or silently produce wrong results?",
 },
 bounds_offbyone: {
  category: "correctness",
  question:
   "Does any index, offset, slice, or loop boundary look like it could read or write out of range (off-by-one, empty-collection access, or a boundary that does not match the collection size)?",
 },
 resource_leak: {
  category: "errors",
  question:
   "Is any resource (file, connection, lock, subscription, timer, stream, DB transaction) acquired but not released on every control-flow path, including the error path?",
 },
 semantic_mismatch: {
  category: "correctness",
  question:
   "Does any piece of logic contradict its own name, an adjacent comment, or the clear expectation of the code that calls it — a sign of a semantic/logic bug rather than a style issue?",
 },
 race_concurrency: {
  category: "correctness",
  question:
   "Is there any shared mutable state, or any interleaving of asynchronous/parallel work, that could produce a race, a lost update, or data corruption?",
 },
 incomplete_implementation: {
  category: "completeness",
  question:
   "Does executable code contain a stub, placeholder, TODO implementation, hard-coded fake result, empty required handler, or not-implemented path that makes the feature materially incomplete? Ignore TODOs that describe optional future improvements without affecting the current contract.",
 },
 unsafe_type_escape: {
  category: "contracts",
  question:
   "Does the code use any, an unchecked cast, a double cast, a non-null assertion, or another type-system escape without a nearby runtime check or invariant that makes the operation safe? Judge semantics, not the mere presence of a cast.",
 },
 contract_mismatch: {
  category: "contracts",
  question:
   "Does the implementation violate a declared type, public API, schema, parameter meaning, return contract, or caller-visible behavior, including accepting important input and silently ignoring it?",
 },
 unchecked_external_data: {
  category: "contracts",
  question:
   "Is untrusted or external data used as a trusted typed value without validation at the boundary, in a way that could cause incorrect behavior or failure? Return false when the code does not process external data.",
 },
 swallowed_error: {
  category: "errors",
  question:
   "Does any catch, callback, or fallback discard a meaningful failure without recovery, propagation, or an intentional documented default, thereby hiding incorrect behavior?",
 },
 misleading_success: {
  category: "errors",
  question:
   "Can a failed or partially failed operation be reported to its caller as success, including returning a success value after suppressing an error or completing only part of required state changes?",
 },
 injection_risk: {
  category: "security",
  question:
   "Is untrusted input interpolated or concatenated into a shell command, query, HTML, code, or another interpreter sink without appropriate parameterization or escaping? Return false when no such source-to-sink path is present.",
 },
 authorization_gap: {
  category: "security",
  question:
   "Does code that performs a protected or user-scoped action lack an authorization check required at this boundary, or confuse authentication with authorization? Return false when this file exposes no protected action or authorization is clearly enforced by its contract.",
 },
 secret_exposure: {
  category: "security",
  question:
   "Could this code expose credentials, tokens, personal data, or other sensitive values through source literals, logs, errors, telemetry, or returned output?",
 },
 untrusted_path_or_url: {
  category: "security",
  question:
   "Can untrusted input control a filesystem path or outbound URL without confinement or an allowlist, creating path traversal, local-file access, or server-side request forgery risk? Return false when no untrusted path or URL exists.",
 },
 unsafe_deserialization: {
  category: "security",
  question:
   "Does the code deserialize, hydrate, evaluate, or reconstruct attacker-controlled data into executable code, privileged objects, or dangerous runtime types without a strict schema and safe format? Return false when deserialization is data-only, validated, or absent.",
 },
 cryptographic_weakness: {
  category: "security",
  question:
   "Does security-sensitive code use broken cryptography, a hard-coded key or nonce, predictable randomness, insecure password hashing, nonce or IV reuse, or encryption without required authentication? Return false when the code performs no security-sensitive cryptographic operation.",
 },
 insecure_transport: {
  category: "security",
  question:
   "Does network code transmit sensitive data over plaintext, disable certificate or hostname verification, trust every certificate, or otherwise weaken transport security? Return false when there is no network transport or secure verification is preserved.",
 },
 unbounded_memory_growth: {
  category: "memory",
  question:
   "Can a collection, cache, queue, buffer, registry, retry history, or accumulated result grow without a bound, eviction policy, backpressure, or lifecycle reset as input or runtime duration increases? Return false when growth is strictly bounded or the data is promptly released.",
 },
 retained_reference_leak: {
  category: "memory",
  question:
   "Can listeners, subscriptions, closures, global registries, caches, timers, or callbacks retain objects beyond their intended lifetime because references are not removed or ownership never ends? Return false when teardown clearly releases the references or no long-lived owner exists.",
 },
 oversized_materialization: {
  category: "memory",
  question:
   "Does the code materialize an entire potentially large or attacker-controlled file, stream, query result, request body, or transformed copy in memory when it should impose a limit, paginate, chunk, or stream? Return false when the input is demonstrably small or bounded.",
 },
 algorithmic_complexity: {
  category: "performance",
  question:
   "Does code on a growing or attacker-controlled input use an avoidable quadratic-or-worse algorithm, such as nested full scans, repeated linear membership checks, or pathological recursion, where a straightforward indexed or linear approach exists? Return false for small bounded inputs or work outside a meaningful path.",
 },
 repeated_expensive_work: {
  category: "performance",
  question:
   "Does a loop or frequently called path unnecessarily repeat invariant parsing, compilation, serialization, allocation, database access, network I/O, or another expensive operation that can safely be performed once or reused? Return false when repetition is required for correctness or the operation is cheap.",
 },
 blocking_hot_path: {
  category: "performance",
  question:
   "Does latency-sensitive, request-handling, event-loop, UI, or asynchronous code perform blocking I/O, unbounded CPU work, or synchronous waiting that can stall unrelated work? Return false when the path is not latency-sensitive or the work is explicitly isolated from shared execution.",
 },
 serial_independent_work: {
  category: "performance",
  question:
   "Does a latency-sensitive path await or execute multiple independent slow operations strictly in sequence even though bounded concurrency or batching would preserve semantics and materially reduce latency? Return false when ordering, rate limits, transactions, resource limits, or dependencies require serialization.",
 },
 speculative_abstraction: {
  category: "design",
  question:
   "Does the code introduce a factory, interface, generic helper, wrapper, strategy, or configuration layer that has no meaningful current variation, type-safety benefit, boundary, or duplication reduction and materially obscures the behavior?",
 },
 useless_indirection: {
  category: "design",
  question:
   "Is there a forwarding layer, wrapper, or helper that adds no validation, policy, transformation, or stable boundary and makes the control flow harder to trace?",
 },
};

/** Backward-compatible question map retained for existing imports and reports. */
export const BUG_CHECKS: Record<string, string> = Object.fromEntries(
 Object.entries(CHECK_DEFINITIONS).map(([name, definition]) => [
  name,
  definition.question,
 ]),
);
export const BUG_NAMES: string[] = Object.keys(CHECK_DEFINITIONS);

// ── judgment types (as the SDK returns them) ─────────────────────────────────

export interface RawScoreAnswer {
 /** Expected score; may fall between integer rubric levels. */
 score: number;
 /** Distribution concentration, NOT overall correctness (see docs/confidence). */
 confidence: number;
 probabilities: Record<string, number>;
}

/**
 * The raw, reusable judgments keyed by question id — the minimal slice of the
 * SDK envelope we keep. Retained so weights/thresholds can change WITHOUT
 * re-calling the API (docs: raw judgments stay reusable).
 */
export interface RawJudgments {
 scores: Record<string, RawScoreAnswer>;
 nouls: Record<string, number>;
 model: string;
 usage?: unknown;
}

// ── report types (what the main LLM reads) ───────────────────────────────────

export type Tier = "pass" | "review" | "block";
export type FlagSeverity = "info" | "warning" | "error";

export interface DimensionAssessment {
 dimension: Dimension;
 raw: number; // expected score on the 0..SCORE_MAX rubric
 max: number; // SCORE_MAX
 normalized: number; // raw / max → 0..1 (1 = best)
 confidence: number;
 probabilities: Record<string, number>;
 /** normalized below the configured floor. */
 flagged: boolean;
 /** flagged AND low confidence → do not auto-apply; a human/reasoning look is needed. */
 uncertain: boolean;
}

export interface BugSignal {
 name: string;
 /** Additive metadata; optional so existing typed report fixtures remain valid. */
 category?: CheckCategory;
 /** What was checked (the noul wording) — the main LLM uses this to look. */
 description: string;
 probability: number; // P(yes)
 action: Tier; // pass | review | block, per policy
 flagged: boolean; // action !== "pass"
}

export interface Flag {
 severity: FlagSeverity;
 kind: "dimension" | "bug" | "uncertainty" | "composite";
 title: string;
 detail: string;
 /** How much to trust the signal as a real problem (model confidence where it exists). */
 confidence: number;
}

export interface ReviewReport {
 /** Path of the code under review, so the main LLM can read it. */
 target?: string;
 model: string;
 dimensions: Record<Dimension, DimensionAssessment>;
 bugSignals: BugSignal[];
 composite: {
  score: number;
  /** Verdict driven by concrete findings. */
  tier: Tier;
  /** Informational tier driven only by configured composite thresholds. */
  contextTier?: Tier;
 };
 /** true → hand the flagged items to the main LLM (or a human) to read + fix. */
 escalate: boolean;
 /** Actionable, ordered error → warning → info. The main LLM's work list. */
 flags: Flag[];
 /** Raw judgments, kept for re-scoring without re-calling the API. */
 raw: RawJudgments;
}
