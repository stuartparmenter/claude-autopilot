import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { info, warn } from "./logger";

/** Prefix applied to all autopilot-managed clone names. Used to namespace
 * autopilot clones and restrict sweepClones() to only remove autopilot-owned
 * directories, leaving human-created clones untouched. */
export const AUTOPILOT_PREFIX = "ap-";

function clonePath(projectPath: string, name: string): string {
  return resolve(projectPath, ".claude", "clones", name);
}

/** Run a git command synchronously. Returns stderr text on failure, undefined on success. */
function gitSync(cwd: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return result.stderr.toString().trim();
  }
  return undefined;
}

/** Run a git command synchronously and return stdout on success, or throw on failure. */
function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

/**
 * Try to remove a directory, retrying on failure (e.g. Windows file locks).
 * Best-effort — logs warnings but never throws.
 *
 * @param expectedParent - The directory that `dirPath` must be inside.
 *   Acts as a defense-in-depth containment check against path traversal.
 */
async function forceRemoveDir(
  dirPath: string,
  name: string,
  expectedParent: string,
): Promise<void> {
  const normalDir = resolve(dirPath);
  const normalParent = resolve(expectedParent);
  if (!normalDir.startsWith(`${normalParent}/`)) {
    warn(
      `Refusing to remove '${name}': path '${normalDir}' is outside expected parent '${normalParent}'`,
    );
    return;
  }

  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 3000, 5000];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
    } catch (e) {
      // If directory is already gone, we're done
      if (!existsSync(dirPath)) return;

      if (attempt === MAX_RETRIES) {
        warn(
          `Failed to remove clone '${name}' after ${MAX_RETRIES + 1} attempts: ${e}`,
        );
        return;
      }

      const delay = RETRY_DELAYS[attempt];
      warn(
        `Failed to remove clone '${name}' (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${e}. Retrying in ${delay}ms...`,
      );
      await Bun.sleep(delay);
      continue;
    }
    // rmSync succeeded
    return;
  }
}

export interface GitIdentity {
  userName: string;
  userEmail: string;
}

export interface CloneResult {
  path: string;
  branch: string;
}

/**
 * Create an isolated git clone for an agent using `git clone --shared`.
 * Each clone gets its own .git/ directory (no lock contention) while reusing
 * the parent's object store via alternates (no disk copy).
 *
 * If a stale clone with the same name exists, removes it first.
 *
 * @param fromBranch - If provided, fetch and check out this existing branch
 *   (for fixers working on PR branches). Otherwise create a fresh branch.
 * @returns the absolute path to the clone directory and the branch name used.
 */
export async function createClone(
  projectPath: string,
  name: string,
  fromBranch?: string,
  gitIdentity?: GitIdentity,
): Promise<CloneResult> {
  const dest = clonePath(projectPath, name);

  // Clean up stale clone directory from a previous crash
  if (existsSync(dest)) {
    warn(`Stale clone found at ${dest}, removing...`);
    const clonesDir = resolve(projectPath, ".claude", "clones");
    await forceRemoveDir(dest, name, clonesDir);

    if (existsSync(dest)) {
      throw new Error(
        `Cannot create clone '${name}': stale directory at ${dest} could not be removed`,
      );
    }
  }

  // Detect the default branch from the parent's remote HEAD (usually main/master).
  // This ensures the clone starts on the right branch regardless of what
  // branch the parent repo currently has checked out.
  let defaultBranch = "main";
  try {
    const ref = gitOutput(projectPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    defaultBranch = ref.replace(/^\/remotes\/origin\//, "");
  } catch {
    // Fallback to "main" if origin/HEAD isn't set
  }

  // Clone with shared objects — reuses parent's object store via alternates.
  // --branch ensures the clone checks out the default branch, not whatever
  // branch the parent happens to be on.
  const cloneErr = gitSync(projectPath, [
    "clone",
    "--shared",
    "--no-tags",
    "--branch",
    defaultBranch,
    projectPath,
    dest,
  ]);
  if (cloneErr) {
    throw new Error(`Failed to create clone '${name}': ${cloneErr}`);
  }

  // The clone's origin points to the local path. Replace it with the
  // real GitHub remote so agents can push.
  const githubUrl = gitOutput(projectPath, ["remote", "get-url", "origin"]);
  const setUrlErr = gitSync(dest, ["remote", "set-url", "origin", githubUrl]);
  if (setUrlErr) {
    throw new Error(
      `Failed to set remote URL in clone '${name}': ${setUrlErr}`,
    );
  }

  // Set bot identity in the clone's local config.
  if (gitIdentity) {
    const nameErr = gitSync(dest, [
      "config",
      "user.name",
      gitIdentity.userName,
    ]);
    if (nameErr) {
      throw new Error(`Failed to set user.name in clone '${name}': ${nameErr}`);
    }
    const emailErr = gitSync(dest, [
      "config",
      "user.email",
      gitIdentity.userEmail,
    ]);
    if (emailErr) {
      throw new Error(
        `Failed to set user.email in clone '${name}': ${emailErr}`,
      );
    }
  }

  // Fetch from GitHub so remote tracking refs are up to date
  // (the initial clone copied refs from the local repo, not GitHub).
  const fetchErr = gitSync(dest, ["fetch", "origin"]);
  if (fetchErr) {
    throw new Error(
      `Failed to fetch from origin in clone '${name}': ${fetchErr}`,
    );
  }

  if (fromBranch) {
    // Fixer/review mode: check out an existing PR branch.
    // The full fetch above already retrieved all remote tracking refs.
    const checkoutErr = gitSync(dest, ["checkout", fromBranch]);
    if (checkoutErr) {
      throw new Error(
        `Failed to checkout branch '${fromBranch}' in clone '${name}': ${checkoutErr}`,
      );
    }

    info(`Created clone: ${name} (from branch ${fromBranch})`);
    return { path: dest, branch: fromBranch };
  }

  // Executor mode: create a fresh branch.
  // Check if a legacy worktree-<name> branch exists on the remote
  // (in-flight PRs from before the rename). The full fetch above already
  // retrieved all remote tracking refs, so we can check locally.
  // Use rev-parse to verify the remote ref exists (avoids ambiguity with
  // file paths that `git checkout` could match).
  const legacyBranch = `worktree-${name}`;
  const legacyExists = gitSync(dest, [
    "rev-parse",
    "--verify",
    `origin/${legacyBranch}`,
  ]);
  const legacyCheckoutErr = legacyExists
    ? "no remote ref"
    : gitSync(dest, ["checkout", legacyBranch]);
  if (!legacyCheckoutErr) {
    info(`Created clone: ${name} (resuming legacy branch ${legacyBranch})`);
    return { path: dest, branch: legacyBranch };
  }

  // New naming: autopilot-<name>
  const branch = `autopilot-${name}`;
  const branchErr = gitSync(dest, ["checkout", "-b", branch]);
  if (branchErr) {
    throw new Error(
      `Failed to create branch '${branch}' in clone '${name}': ${branchErr}`,
    );
  }
  info(`Created clone: ${name} (branch ${branch})`);
  return { path: dest, branch };
}

/**
 * Remove a clone directory.
 * Best-effort — retries on failure (Windows file locks), never throws.
 */
export async function removeClone(
  projectPath: string,
  name: string,
): Promise<void> {
  const dest = clonePath(projectPath, name);
  const clonesDir = resolve(projectPath, ".claude", "clones");
  info(`Removing clone: ${name}`);
  await forceRemoveDir(dest, name, clonesDir);
}

/**
 * Sweep stale clones under `<projectPath>/.claude/clones/`.
 * Removes any clone whose name is not in `activeNames`.
 * Best-effort — failures on individual clones are logged but do not
 * prevent cleanup of the remaining ones or crash the process.
 *
 * @param activeNames - Set of clone names currently in use by running agents.
 *   Pass an empty set on startup (all found clones are stale by definition).
 */
export async function sweepClones(
  projectPath: string,
  activeNames: Set<string> = new Set(),
): Promise<void> {
  const clonesDir = resolve(projectPath, ".claude", "clones");
  let entries: string[];
  try {
    entries = readdirSync(clonesDir) as string[];
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      return; // Directory does not exist yet — nothing to sweep
    }
    warn(`Failed to read clones directory '${clonesDir}': ${e}`);
    return;
  }

  const stale = entries.filter(
    (name) => name.startsWith(AUTOPILOT_PREFIX) && !activeNames.has(name),
  );
  if (stale.length > 0) {
    info(`Sweeping ${stale.length} stale clone(s): ${stale.join(", ")}`);
  }

  for (const name of stale) {
    try {
      await removeClone(projectPath, name);
    } catch (e) {
      warn(`Sweep: failed to remove clone '${name}': ${e}`);
    }
  }
}

/**
 * Sweep legacy worktrees from `.claude/worktrees/` (migration cleanup).
 * Call once on startup to clean up directories from before the clone migration.
 */
export async function sweepLegacyWorktrees(projectPath: string): Promise<void> {
  const worktreesDir = resolve(projectPath, ".claude", "worktrees");
  let entries: string[];
  try {
    entries = readdirSync(worktreesDir) as string[];
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      return; // Directory doesn't exist — nothing to clean
    }
    warn(`Failed to read legacy worktrees directory '${worktreesDir}': ${e}`);
    return;
  }

  if (entries.length > 0) {
    info(
      `Sweeping ${entries.length} legacy worktree(s): ${entries.join(", ")}`,
    );
  }

  for (const name of entries) {
    const dirPath = resolve(worktreesDir, name);
    try {
      rmSync(dirPath, { recursive: true, force: true });
    } catch (e) {
      warn(`Failed to remove legacy worktree '${name}': ${e}`);
    }
  }

  // Remove the now-empty worktrees directory itself
  try {
    rmSync(worktreesDir, { recursive: true, force: true });
  } catch (e) {
    warn(`Failed to remove legacy worktrees directory: ${e}`);
  }
}
