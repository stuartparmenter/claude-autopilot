import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const AUTOPILOT_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
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
 * Substitute {{VARIABLE}} placeholders in a template string.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
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

/**
 * Build the full auditor prompt with subagent prompts appended.
 */
export function buildAuditorPrompt(vars: Record<string, string>): string {
  const auditor = buildPrompt("auditor", vars);
  const planner = loadPrompt("planner");
  const verifier = loadPrompt("verifier");
  const security = loadPrompt("security-reviewer");

  return `${auditor}

---

# Reference: Subagent Prompts

Use these prompts when spawning Agent Team subagents. Provide them as the system prompt for each subagent.

## Planner Subagent Prompt

${planner}

## Verifier Subagent Prompt

${verifier}

## Security Reviewer Subagent Prompt

${security}`;
}
