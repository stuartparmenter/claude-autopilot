import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTOPILOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Load a prompt template from the prompts/ directory.
 */
export function loadPrompt(name: string): string {
  const path = resolve(AUTOPILOT_ROOT, "prompts", `${name}.md`);
  return readFileSync(path, "utf-8");
}

/**
 * Sanitize a value before substituting it into a prompt template.
 * Collapses newlines to spaces and strips leading markdown heading markers
 * to prevent prompt injection via multiline config values.
 */
function sanitizePromptValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*#+\s*/, "")
    .trim();
}

/**
 * Substitute {{VARIABLE}} placeholders in a template string.
 * Values are sanitized before substitution to prevent prompt injection.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, sanitizePromptValue(value));
  }
  return result;
}

/**
 * Load and render a prompt template in one step.
 */
export function buildPrompt(
  name: string,
  vars: Record<string, string>,
): string {
  return renderPrompt(loadPrompt(name), vars);
}
