import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { info, warn } from "./logger";

/**
 * Create an isolated git worktree for an agent.
 * If a stale worktree with the same name exists, removes it first.
 * Returns the absolute path to the worktree directory.
 */
export function createWorktree(projectPath: string, name: string): string {
  const wtPath = resolve(projectPath, ".claude", "worktrees", name);
  const branch = `worktree-${name}`;

  // Prune stale worktree references first — if a worktree directory was
  // deleted without `git worktree remove`, git still thinks the branch is
  // checked out there and refuses to delete it.
  Bun.spawnSync(["git", "worktree", "prune"], {
    cwd: projectPath,
    stderr: "pipe",
  });

  // Clean up stale worktree/branch from a previous crash
  if (existsSync(wtPath)) {
    warn(`Stale worktree found at ${wtPath}, removing...`);
    removeWorktree(projectPath, name);
  }

  // Branch might exist without the worktree directory (partial cleanup,
  // or leftover from old SDK --worktree flag). Delete it so we can recreate.
  Bun.spawnSync(["git", "branch", "-D", branch], {
    cwd: projectPath,
    stderr: "pipe",
  });

  info(`Creating worktree: ${name}`);
  const result = Bun.spawnSync(
    ["git", "worktree", "add", wtPath, "-b", branch],
    { cwd: projectPath, stderr: "pipe" },
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`Failed to create worktree '${name}': ${stderr}`);
  }

  return wtPath;
}

/**
 * Remove a worktree and its local branch. Best-effort — logs errors but never throws.
 */
export function removeWorktree(projectPath: string, name: string): void {
  const wtPath = resolve(projectPath, ".claude", "worktrees", name);
  const branch = `worktree-${name}`;

  info(`Removing worktree: ${name}`);

  const wtResult = Bun.spawnSync(
    ["git", "worktree", "remove", wtPath, "--force"],
    { cwd: projectPath, stderr: "pipe" },
  );
  if (wtResult.exitCode !== 0) {
    const stderr = wtResult.stderr.toString().trim();
    warn(`Failed to remove worktree '${name}': ${stderr}`);
  }

  // Prune so git doesn't think the branch is still checked out
  Bun.spawnSync(["git", "worktree", "prune"], {
    cwd: projectPath,
    stderr: "pipe",
  });

  const brResult = Bun.spawnSync(["git", "branch", "-D", branch], {
    cwd: projectPath,
    stderr: "pipe",
  });
  if (brResult.exitCode !== 0) {
    const stderr = brResult.stderr.toString().trim();
    // Branch may not exist — not critical
    warn(`Failed to delete branch '${branch}': ${stderr}`);
  }
}
