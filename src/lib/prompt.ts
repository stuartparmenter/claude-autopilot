import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTOPILOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Load a prompt template, checking for a project-local override first.
 *
 * If `projectPath` is provided, checks `<projectPath>/.autopilot/prompts/<name>.md`
 * before falling back to the bundled `prompts/<name>.md`.
 *
 * If the project-local file contains `{{BASE_PROMPT}}`, that placeholder is
 * replaced with the content of the bundled prompt, allowing partial overrides
 * that augment rather than fully replace the bundled template.
 */
export function loadPrompt(name: string, projectPath?: string): string {
  const bundledPath = resolve(AUTOPILOT_ROOT, "prompts", `${name}.md`);
  const bundled = readFileSync(bundledPath, "utf-8");

  if (!projectPath) return bundled;

  const overridePath = resolve(
    projectPath,
    ".autopilot",
    "prompts",
    `${name}.md`,
  );
  if (!existsSync(overridePath)) return bundled;

  const override = readFileSync(overridePath, "utf-8");
  return override.includes("{{BASE_PROMPT}}")
    ? override.replaceAll("{{BASE_PROMPT}}", bundled)
    : override;
}

/**
 * Sanitize a value before substituting it into a prompt template.
 * Collapses newlines to spaces and strips leading markdown heading markers
 * to prevent prompt injection via multiline config values.
 */
export function sanitizePromptValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*#+\s*/, "")
    .trim();
}

/**
 * Substitute {{VARIABLE}} placeholders in a template string.
 * Values in `vars` are sanitized before substitution to prevent prompt injection.
 * Values in `rawVars` are substituted as-is (use only for pre-sanitized multi-line content).
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
  rawVars: Record<string, string> = {},
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, sanitizePromptValue(value));
  }
  for (const [key, value] of Object.entries(rawVars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Load and render a prompt template in one step.
 *
 * If `projectPath` is provided, checks for a project-local override before
 * loading the bundled template. See `loadPrompt` for override details.
 *
 * Values in `rawVars` are substituted as-is (use only for pre-sanitized multi-line content).
 */
export function buildPrompt(
  name: string,
  vars: Record<string, string>,
  projectPath?: string,
  rawVars: Record<string, string> = {},
): string {
  return renderPrompt(loadPrompt(name, projectPath), vars, rawVars);
}
