import assert from "node:assert/strict";
import { test } from "node:test";
import { splitSections } from "../extension/split.ts";

test("a file without level-2 headings is one whole-file section", () => {
  const text = "# Title\n\nJust prose, no sections.\n";
  const sections = splitSections(text);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.start, 1);
  assert.deepEqual(sections[0]!.end, 4);
  assert.deepEqual(sections[0]!.heading, "");
  assert.deepEqual(sections[0]!.code, text);
});

test("sections carry 1-based inclusive ranges and keep their heading line", () => {
  const text = [
    "# Doc",
    "",
    "Intro text.",
    "",
    "## Alpha",
    "Alpha body.",
    "",
    "## Beta",
    "Beta body.",
    "Tail line.",
  ].join("\n");
  const sections = splitSections(text);

  assert.equal(sections.length, 3);
  const [intro, alpha, beta] = sections;
  assert.deepEqual({ ...intro, code: undefined }, {
    start: 1,
    end: 4,
    heading: "",
    code: undefined,
  });
  assert.deepEqual(alpha?.code, "## Alpha\nAlpha body.\n");
  assert.deepEqual({ start: alpha?.start, end: alpha?.end, heading: alpha?.heading }, {
    start: 5,
    end: 7,
    heading: "Alpha",
  });
  assert.deepEqual({ start: beta?.start, end: beta?.end, heading: beta?.heading }, {
    start: 8,
    end: 10,
    heading: "Beta",
  });
  assert.deepEqual(beta?.code, "## Beta\nBeta body.\nTail line.");
});

test("level-2 headings inside fenced code blocks are not boundaries", () => {
  const text = [
    "## Real",
    "```bash",
    "## shell comment, not a heading",
    "echo done",
    "```",
    "After the fence.",
    "",
    "~~~",
    "## inside tildes",
    "~~~",
    "",
    "## Second",
    "Second body.",
  ].join("\n");
  const sections = splitSections(text);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["Real", "Second"],
  );
  assert.match(sections[0]!.code, /## shell comment, not a heading/);
});

test("'##Heading' without a space and deeper levels are not boundaries", () => {
  const text = [
    "##Heading no space",
    "### Sub heading",
    "###Another",
    "## Real one",
    "Body.",
  ].join("\n");
  const sections = splitSections(text);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["", "Real one"],
  );
});

test("the last section runs to the end of file", () => {
  const text = "## Only\n\nLast words.\n";
  const sections = splitSections(text);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.end, 4);
  assert.deepEqual(sections[0]!.code, text);
});

test("a heading with no body still yields a single-line section", () => {
  const text = "## Dangling\n";
  const sections = splitSections(text);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.code, "## Dangling\n");
});
