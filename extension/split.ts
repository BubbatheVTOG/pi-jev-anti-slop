/**
 * Section splitting for section-level (divide-and-conquer) reviews.
 *
 * Splits a file into level-2-heading (`## `) sections and returns each with
 * 1-based inclusive line ranges and its verbatim source. Callers can always
 * iterate sections uniformly: a file without level-2 headings yields a single
 * section covering the whole file, so "whole-file review" is the degenerate
 * case of the same loop.
 *
 * Deliberately minimal and predictable:
 *  - only `## ` (hash, space, at least one non-space) starts a section —
 *    `##Heading` and `### Heading` are not boundaries
 *  - lines inside fenced code blocks (``` or ~~~, up to 3 leading spaces)
 *    never count as boundaries, so `## comment` lines in shell/python examples
 *    and `## ` text in code fences do not split the file
 *  - a section's `code` includes its own heading line (context for the
 *    reviewer) and everything up to, but not including, the next boundary
 *  - the text before the first heading is returned as an intro section with
 *    an empty heading when it exists
 */

export interface SourceSection {
 /** 1-based inclusive first line of the section (its heading line, if any). */
 start: number;
 /** 1-based inclusive last line of the section. */
 end: number;
 /** Heading text; "" for the intro or a headingless whole file. */
 heading: string;
 /** Verbatim section source, including the heading line. */
 code: string;
}

const BOUNDARY = /^## (\S.*?)\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

export function splitSections(text: string): SourceSection[] {
 const lines = text.split("\n");
 const boundaries: { start: number; heading: string }[] = [];
 let inFence = false;
 for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (FENCE.test(line)) {
   inFence = !inFence;
   continue;
  }
  if (inFence) continue;
  const match = line.match(BOUNDARY);
  if (match) boundaries.push({ start: i + 1, heading: match[1].trim() });
 }

 const sections: SourceSection[] = [];
 const push = (start: number, end: number, heading: string): void => {
  if (end < start) return;
  sections.push({
   start,
   end,
   heading,
   code: lines.slice(start - 1, end).join("\n"),
  });
 };

 if (boundaries.length === 0) {
  push(1, lines.length, "");
  return sections;
 }
 if (boundaries[0].start > 1) push(1, boundaries[0].start - 1, "");
 boundaries.forEach((boundary, index) => {
  const next = boundaries[index + 1]?.start ?? lines.length + 1;
  push(boundary.start, next - 1, boundary.heading);
 });
 return sections;
}
