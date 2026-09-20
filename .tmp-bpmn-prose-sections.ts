// Temporary section-level prose reviewer for the Activiti BPMN docs sweep.
// Usage: node .tmp-bpmn-prose-sections.ts <rootDir> <relFile> [relFile...]
// Splits each file into `## ` sections and runs the SAME runReview(..., "prose")
// path the jev_review tool uses, one request per section. Emits JSONL:
// {file, start, end, heading, signals: [{name, probability}]}
// Deleted after the sweep; never committed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { runReview } from "./extension/review.ts";
import { redactLikelySecrets } from "./extension/path-policy.ts";

const [rootArg, ...relPaths] = process.argv.slice(2);
if (!rootArg || relPaths.length === 0) {
  console.error("usage: .tmp-bpmn-prose-sections.ts <rootDir> <relFile>...");
  process.exit(2);
}
const root = resolve(rootArg);
const client = new TypeSafeClient();

type Section = { start: number; end: number; heading: string; code: string };

function splitSections(text: string): Section[] {
  const lines = text.split("\n");
  const boundaries: { start: number; heading: string }[] = [];
  lines.forEach((line, index) => {
    if (/^## /.test(line)) boundaries.push({ start: index + 1, heading: line.replace(/^## /, "").trim() });
  });
  const sections: Section[] = [];
  if (boundaries.length === 0) {
    sections.push({ start: 1, end: lines.length, heading: "(whole file)", code: text });
    return sections;
  }
  if (boundaries[0].start > 1) {
    sections.push({
      start: 1,
      end: boundaries[0].start - 1,
      heading: "(intro)",
      code: lines.slice(0, boundaries[0].start - 1).join("\n"),
    });
  }
  boundaries.forEach((b, i) => {
    const next = boundaries[i + 1]?.start ?? lines.length + 1;
    sections.push({ start: b.start, end: next - 1, heading: b.heading, code: lines.slice(b.start - 1, next - 1).join("\n") });
  });
  return sections;
}

let totalSections = 0;
for (const rel of relPaths) {
  const abs = resolve(root, rel);
  const sections = splitSections(readFileSync(abs, "utf8"));
  totalSections += sections.length;
}

let done = 0;
const emit = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};
for (const rel of relPaths) {
  const abs = resolve(root, rel);
  const sections = splitSections(readFileSync(abs, "utf8"));
  for (const section of sections) {
    done += 1;
    process.stderr.write(`[${done}/${totalSections}] ${rel} L${section.start}-${section.end} ${section.heading}\n`);
    const sanitized = redactLikelySecrets(section.code);
    let note = `chunk review: judge only the supplied chunk from ${rel}; inspect surrounding code before acting on a flag; `;
    if (sanitized.redacted) note += "[credentials redacted before review] ";
    try {
      const raw = await runReview(
        client,
        {
          path: rel,
          language: "markdown",
          note,
          code: sanitized.code,
        },
        "prose",
      );
      const signals = Object.entries(raw.nouls ?? {}).filter(([, p]) => p >= 0.5).map(([name, probability]) => ({ name, probability: Number(probability.toFixed(2)) }));
      emit({
        file: rel,
        start: section.start,
        end: section.end,
        heading: section.heading,
        signals,
      });
    } catch (error) {
      emit({ file: rel, start: section.start, end: section.end, heading: section.heading, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
