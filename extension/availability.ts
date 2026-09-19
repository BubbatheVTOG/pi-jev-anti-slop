/**
 * Availability gate for the Jev reviewer.
 *
 * Mirrors agent-voice's resolveAgentSayBin(): one pure capability check that the
 * extension factory runs at load. If the key is absent the whole extension
 * registers NOTHING (no tool, no command, no status) — the same no-op model as
 * the cloud/voice toggles, keyed on our env var.
 *
 * TYPESAFE_API_KEY does two jobs at once: it is the gate AND the SDK's API key
 * (the SDK reads it from the environment by default, so we never echo it into
 * a request or log).
 */

const KEY_ENV = "TYPESAFE_API_KEY";

/** Resolve the key from env, or null when missing/blank. */
export function resolveKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[KEY_ENV];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/** True when the reviewer is active in this environment. */
export function hasKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveKey(env) !== null;
}

/** A short, non-secret marker for status displays — never the key itself. */
export function keyMasked(env: NodeJS.ProcessEnv = process.env): string {
  const k = resolveKey(env);
  if (!k) return "unset";
  if (k.length <= 8) return "set(≤8 chars)";
  return `set(${k.slice(0, 4)}…${k.slice(-4)}, ${k.length} chars)`;
}
