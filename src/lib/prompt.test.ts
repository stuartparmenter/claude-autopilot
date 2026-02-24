import { describe, expect, test } from "bun:test";
import { renderPrompt } from "./prompt";

describe("renderPrompt", () => {
  test("substitutes simple values", () => {
    expect(renderPrompt("Hello {{NAME}}", { NAME: "World" })).toBe(
      "Hello World",
    );
  });

  test("collapses newlines in substituted values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "foo\n## EVIL\nbar" })).toBe(
      "foo ## EVIL bar",
    );
  });

  test("collapses CRLF newlines", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "foo\r\nbar" })).toBe("foo bar");
  });

  test("strips leading heading markers from values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "## Heading value" })).toBe(
      "Heading value",
    );
  });

  test("does not alter legitimate values", () => {
    expect(renderPrompt("{{KEY}}", { KEY: "My Project (v2)" })).toBe(
      "My Project (v2)",
    );
    expect(renderPrompt("{{KEY}}", { KEY: "In Review" })).toBe("In Review");
    expect(renderPrompt("{{KEY}}", { KEY: "ENG" })).toBe("ENG");
  });

  test("mid-string heading markers are preserved (not at start of string)", () => {
    // After newline collapsing, mid-string ## is harmless
    const result = renderPrompt("{{KEY}}", { KEY: "foo\n## EVIL\nbar" });
    expect(result).toBe("foo ## EVIL bar");
    expect(result).not.toContain("\n");
  });
});
