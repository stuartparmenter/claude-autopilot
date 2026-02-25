import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { info, warn } from "./logger";

function worktreePath(projectPath: string, name: string): string {
  return resolve(projectPath, ".claude", "worktrees", name);
}

/** Run a git command synchronously. Returns stderr text on failure, undefined on success. */
function gitSync(projectPath: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: projectPath,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return result.stderr.toString().trim();
  }
  return undefined;
}

function gitPrune(projectPath: string): void {
  gitSync(projectPath, ["worktree", "prune"]);
}

/** Sleep asynchronously for use in retry loops. */
async function sleepMs(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/**
 * Try to remove a directory, retrying on failure (e.g. Windows file locks).
 * Uses git worktree remove first, falls back to rmSync.
 */
async function forceRemoveDir(
  projectPath: string,
  wtPath: string,
  name: string,
): Promise<void> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 3000, 5000];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Try git worktree remove first (cleanest)
    const err = gitSync(projectPath, ["worktree", "remove", wtPath, "--force"]);
    if (!err) return;

    // If directory is already gone, we're done
    if (!existsSync(wtPath)) return;

    // On last attempt, try brute-force rmSync
    if (attempt === MAX_RETRIES) {
      warn(
        `git worktree remove failed after ${MAX_RETRIES} retries, trying rmSync`,
      );
      try {
        rmSync(wtPath, { recursive: true, force: true });
      } catch (e) {
        warn(`rmSync also failed for '${name}': ${e}`);
      }
      // Prune so git forgets about the now-deleted directory
      gitPrune(projectPath);
      return;
    }

    // Wait before retrying — file locks may release
    const delay = RETRY_DELAYS[attempt];
    warn(
      `Failed to remove worktree '${name}' (attempt ${attempt + 1}/${MAX_RETRIES}): ${err}. Retrying in ${delay}ms...`,
    );
    await sleepMs(delay);
  }
}

/**
 * Create an isolated git worktree for an agent.
 * If a stale worktree with the same name exists, removes it first.
 *
 * @param fromBranch - If provided, fetch and check out this existing branch
 *   (for fixers working on PR branches). Otherwise create a fresh branch from HEAD.
 * @returns the absolute path to the worktree directory.
 */
export async function createWorktree(
  projectPath: string,
  name: string,
  fromBranch?: string,
): Promise<string> {
  const wtPath = worktreePath(projectPath, name);

  // Prune stale worktree references first — if a worktree directory was
  // deleted without `git worktree remove`, git still thinks the branch is
  // checked out there and refuses to delete it.
  gitPrune(projectPath);

  // Clean up stale worktree directory from a previous crash
  if (existsSync(wtPath)) {
    warn(`Stale worktree found at ${wtPath}, removing...`);
    await forceRemoveDir(projectPath, wtPath, name);

    // If it STILL exists after retries, we can't proceed
    if (existsSync(wtPath)) {
      throw new Error(
        `Cannot create worktree '${name}': stale directory at ${wtPath} could not be removed`,
      );
    }

    // Clean up the branch reference too (unless keeping for fixer)
    if (!fromBranch) {
      gitSync(projectPath, ["branch", "-D", `worktree-${name}`]);
    }

    // Prune again after forced removal
    gitPrune(projectPath);
  }

  if (fromBranch) {
    // Fixer mode: check out an existing PR branch into the worktree.
    gitSync(projectPath, ["fetch", "origin", fromBranch]);

    info(`Creating worktree: ${name} (from branch ${fromBranch})`);
    const err = gitSync(projectPath, ["worktree", "add", wtPath, fromBranch]);
    if (err) {
      throw new Error(`Failed to create worktree '${name}': ${err}`);
    }
  } else {
    // Executor mode: create a fresh branch from HEAD.
    const branch = `worktree-${name}`;

    // Branch might exist without the worktree directory (partial cleanup,
    // or leftover from old SDK --worktree flag). Delete it so we can recreate.
    gitSync(projectPath, ["branch", "-D", branch]);

    info(`Creating worktree: ${name}`);
    const err = gitSync(projectPath, ["worktree", "add", wtPath, "-b", branch]);
    if (err) {
      throw new Error(`Failed to create worktree '${name}': ${err}`);
    }
  }

  return wtPath;
}

/**
 * Remove a worktree and (optionally) its local branch.
 * Best-effort — retries on failure (Windows file locks), never throws.
 *
 * @param keepBranch - If true, only remove the worktree directory, don't
 *   delete the branch. Used for fixer worktrees where the branch is the PR branch.
 */
export async function removeWorktree(
  projectPath: string,
  name: string,
  opts?: { keepBranch?: boolean },
): Promise<void> {
  const wtPath = worktreePath(projectPath, name);

  info(`Removing worktree: ${name}`);
  await forceRemoveDir(projectPath, wtPath, name);

  gitPrune(projectPath);

  if (!opts?.keepBranch) {
    const branch = `worktree-${name}`;
    const brErr = gitSync(projectPath, ["branch", "-D", branch]);
    if (brErr) {
      warn(`Failed to delete branch '${branch}': ${brErr}`);
    }
  }
}
