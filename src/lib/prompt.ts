import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUTOPILOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * Load a prompt template, checking for a project-local override first.
 *
 * If `projectPath` is provided, checks `<projectPath>/.claude-autopilot/prompts/<name>.md`
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
    ".claude-autopilot",
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
 *
 * If `projectPath` is provided, checks for a project-local override before
 * loading the bundled template. See `loadPrompt` for override details.
 */
export function buildPrompt(
  name: string,
  vars: Record<string, string>,
  projectPath?: string,
): string {
  return renderPrompt(loadPrompt(name, projectPath), vars);
}

/**
 * Build the full auditor prompt with subagent prompts appended.
 *
 * If `projectPath` is provided, each sub-prompt is resolved with project-local
 * override support. See `loadPrompt` for override details.
 */
export function buildAuditorPrompt(
  vars: Record<string, string>,
  projectPath?: string,
): string {
  const auditor = buildPrompt("auditor", vars, projectPath);
  const planner = loadPrompt("planner", projectPath);
  const verifier = loadPrompt("verifier", projectPath);
  const security = loadPrompt("security-reviewer", projectPath);
  const productManager = buildPrompt("product-manager", vars, projectPath);

  return `${auditor}

---

# Reference: Subagent Prompts

Use these prompts when spawning Agent Team subagents. Provide them as the system prompt for each subagent.

## Planner Subagent Prompt

${planner}

## Verifier Subagent Prompt

${verifier}

## Security Reviewer Subagent Prompt

${security}

## Product Manager Subagent Prompt

${productManager}`;
}
