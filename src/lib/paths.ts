import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the claude-autopilot repository root. */
export const AUTOPILOT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
