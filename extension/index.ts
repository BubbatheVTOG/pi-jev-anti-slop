/**
 * pi-jev-anti-slop — a TypeSafe Jev code-review judgment for LLM agent review loops.
 *
 * Gate (mirrors agent-voice / cloud-toggle): if TYPESAFE_API_KEY is not set, this
 * extension registers NOTHING — no tool, no command. That is the "not active when
 * the key is absent" behavior you asked for, keyed on your env var.
 *
 * One variable does both jobs: it is the on/off gate AND the SDK's API key (the
 * SDK reads TYPESAFE_API_KEY from the environment by default), so the key is never
 * echoed into a request or a log.
 *
 * A reviewer is a *triage* step. Jev returns typed judgments + probabilities
 * (docs.typesafe.ai) — it does not explain or fix. The main LLM reads the flag
 * report + the actual code and writes the real fix. That round trip is the review
 * loop this extension serves.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { hasKey } from "./availability.ts";
import { resolveConfig } from "./config.ts";
import { registerJevCommand } from "./jev-command.ts";
import { registerJevReviewTool } from "./jev-tool.ts";

export default function jevAntiSlop(pi: ExtensionAPI): void {
 // No key → silent no-op; nothing is registered.
 if (!hasKey()) return;

 // One client for the process. No `model` is passed: the SDK uses its default
 // (currently "jev-latest"), so we never hardcode a version that can go stale.
 let client: TypeSafeClient;
 try {
  client = new TypeSafeClient();
 } catch {
  // A malformed key or invalid SDK configuration must not break pi startup.
  // The extension remains inactive until the environment is corrected and pi reloads.
  return;
 }
 const getConfig = (
  cwd: string,
  projectTrusted: boolean,
 ): ReturnType<typeof resolveConfig> => resolveConfig({ cwd, projectTrusted });

 registerJevReviewTool(pi, client, getConfig);
 registerJevCommand(pi, client, getConfig);
}
