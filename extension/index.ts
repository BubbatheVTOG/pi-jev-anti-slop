/**
 * pi-jev-anti-slop — a TypeSafe Jev code-review judgment for LLM agent review loops.
 *
 * The extension is enabled by default and can be explicitly disabled with
 * `jev.disable: true`. API-key availability does not control registration; the SDK
 * reports credential errors when a review is attempted without a usable key.
 *
 * A reviewer is a *triage* step. Jev returns typed judgments + probabilities
 * (docs.typesafe.ai) — it does not explain or fix. The main LLM reads the flag
 * report + the actual code and writes the real fix. That round trip is the review
 * loop this extension serves.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { resolveConfig } from "./config.ts";
import { registerJevCommand } from "./jev-command.ts";
import { registerJevReviewTool } from "./jev-tool.ts";

export default function jevAntiSlop(pi: ExtensionAPI): void {
 // A global disable prevents registration. Invalid settings are handled by the
 // command/tool configuration boundary rather than breaking Pi startup.
 try {
  if (resolveConfig({ cwd: process.cwd(), projectTrusted: false }).disable)
   return;
 } catch {
  // Keep the extension registered so invocation can report the configuration error.
 }

 // One client for the process. No `model` is passed: the SDK uses its default
 // (currently "jev-latest"), so we never hardcode a version that can go stale.
 let client: TypeSafeClient;
 try {
  client = new TypeSafeClient();
 } catch {
  // Invalid SDK configuration must not break Pi startup.
  return;
 }
 const getConfig = (
  cwd: string,
  projectTrusted: boolean,
 ): ReturnType<typeof resolveConfig> => resolveConfig({ cwd, projectTrusted });

 registerJevReviewTool(pi, client, getConfig);
 registerJevCommand(pi, client, getConfig);
}
