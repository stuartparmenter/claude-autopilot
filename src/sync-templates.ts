#!/usr/bin/env bun

/**
 * sync-templates.ts - Create or update Linear issue templates used by the planning system.
 *
 * Usage: bun run sync-templates <project-path>
 *
 * Creates two issue templates on the configured Linear team:
 *   - "Autopilot Finding" — for bugs, security, tooling, architecture, quality findings
 *   - "Autopilot Feature" — for feature ideas
 *
 * Idempotent: re-running updates existing templates in place.
 */

import { loadConfig, resolveProjectPath } from "./lib/config";
import { findTeam, getLinearClient } from "./lib/linear";
import { fatal, header, info, ok, warn } from "./lib/logger";
import { withRetry } from "./lib/retry";

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

const TEMPLATES = [
  {
    name: "Autopilot Finding",
    description:
      "Issue template for bugs, security, tooling, architecture, and quality findings filed by the planning system.",
    templateData: {
      description: [
        "## Context",
        "[Why this matters. Current state and what's wrong.]",
        "",
        "## Goal",
        "[Desired end state. What should be true after this is resolved.]",
        "",
        "## Affected Areas",
        "[Specific file paths, modules, and functions involved.]",
        "",
        "## Codebase Context",
        "[Existing patterns and conventions. How similar things are done in this codebase. Relevant CLAUDE.md rules.]",
        "",
        "## Constraints",
        "[Things that must not break. Backward compatibility requirements. Performance budgets. Patterns to follow.]",
        "",
        "## Current Test Coverage",
        "[What tests exist for this area. Test file locations. How this area is tested today.]",
        "",
        "## Acceptance Criteria",
        "- [ ] [Machine-verifiable criterion]",
        "",
        "## Security Notes",
        '[Risk assessment. Or "No security implications."]',
      ].join("\n"),
    },
  },
  {
    name: "Autopilot Feature",
    description:
      "Issue template for feature ideas filed by the planning system.",
    templateData: {
      description: [
        "## Motivation",
        "[What user problem or opportunity does this address? Why now?]",
        "",
        "## User Impact",
        "[Who benefits and how. What changes from the user's perspective.]",
        "",
        "## Goal",
        "[Desired end state. What should be true after this feature ships.]",
        "",
        "## Prior Art",
        "[How similar features work in this codebase or comparable products. Integration points with the existing system.]",
        "",
        "## Acceptance Criteria",
        "- [ ] [Machine-verifiable criterion]",
        "",
        "## Security Notes",
        '[Risk assessment. Or "No security implications."]',
      ].join("\n"),
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const projectPath = resolveProjectPath(process.argv[2]);
const config = loadConfig(projectPath);

if (!config.linear.team) {
  fatal("linear.team is not set in .autopilot.yml. Run 'bun run setup' first.");
}

header("Syncing Linear issue templates");

info(`Team: ${config.linear.team}`);

const team = await findTeam(config.linear.team);
const existingTemplates = await withRetry(
  () => team.templates(),
  "fetchTemplates",
);

const client = getLinearClient();

for (const tmpl of TEMPLATES) {
  const existing = existingTemplates.nodes.find((t) => t.name === tmpl.name);

  if (existing) {
    info(`Updating "${tmpl.name}" (${existing.id})...`);
    const payload = await withRetry(
      () =>
        client.updateTemplate(existing.id, {
          description: tmpl.description,
          templateData: tmpl.templateData,
        }),
      `updateTemplate(${tmpl.name})`,
    );
    if (payload.success) {
      ok(`Updated "${tmpl.name}"`);
    } else {
      warn(`Failed to update "${tmpl.name}"`);
    }
  } else {
    info(`Creating "${tmpl.name}"...`);
    const payload = await withRetry(
      () =>
        client.createTemplate({
          type: "issue",
          name: tmpl.name,
          description: tmpl.description,
          teamId: team.id,
          templateData: tmpl.templateData,
        }),
      `createTemplate(${tmpl.name})`,
    );
    if (payload.success) {
      ok(`Created "${tmpl.name}"`);
    } else {
      warn(`Failed to create "${tmpl.name}"`);
    }
  }
}

header("Done!");
console.log("Templates are now available in Linear under your team settings.");
console.log(
  "The issue-planner agent will automatically find and use these templates.",
);
console.log();
