import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";

import { createClone, removeClone, sweepClones } from "./sandbox-clone";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnResult = ReturnType<typeof Bun.spawnSync>;

function spawnOk(stdout = ""): SpawnResult {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(""),
    success: true,
  } as SpawnResult;
}

function spawnFail(stderr = "git error"): SpawnResult {
  return {
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from(stderr),
    success: false,
  } as SpawnResult;
}

const PROJECT = "/project";

// Top-level spy variables — reassigned in beforeEach so tests can inspect them.
// spyOn on the node:fs namespace object intercepts calls made by sandbox-clone.ts
// without using mock.module (which causes permanent leakage — Bun bug #7823).
let existsSpy: ReturnType<typeof spyOn<typeof fs, "existsSync">>;
let rmSyncSpy: ReturnType<typeof spyOn<typeof fs, "rmSync">>;
let readdirSyncSpy: ReturnType<typeof spyOn<typeof fs, "readdirSync">>;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;
let sleepSpy: ReturnType<typeof spyOn<typeof Bun, "sleep">>;

/** Default spawnSync handler: succeeds for all commands, returns GitHub URL for remote get-url. */
function defaultSpawnHandler(cmds: string[]): SpawnResult {
  // git remote get-url origin → return a GitHub URL
  if (cmds[1] === "remote" && cmds[2] === "get-url") {
    return spawnOk("git@github.com:owner/repo.git");
  }
  // git ls-remote → no legacy branch by default
  if (cmds[1] === "ls-remote") {
    return spawnOk("");
  }
  return spawnOk();
}

beforeEach(() => {
  existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
  rmSyncSpy = spyOn(fs, "rmSync").mockReturnValue(
    undefined as unknown as undefined,
  );
  readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([] as any);
  spawnSpy = spyOn(Bun, "spawnSync").mockImplementation(((cmds: string[]) =>
    defaultSpawnHandler(cmds)) as any);
  sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(
    undefined as unknown as undefined,
  );
});

afterEach(() => mock.restore());

// ---------------------------------------------------------------------------
// createClone — executor mode (no fromBranch)
// ---------------------------------------------------------------------------

describe("createClone — executor mode", () => {
  test("returns { path, branch } with path containing .claude/clones/<name>", async () => {
    const result = await createClone(PROJECT, "ENG-1");
    expect(result.path).toContain(".claude/clones/ENG-1");
    expect(result.branch).toBe("autopilot-ENG-1");
  });

  test("runs git clone --shared --single-branch --no-tags", async () => {
    await createClone(PROJECT, "ENG-42");

    const cloneCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "clone" &&
        c[0].includes("--shared") &&
        c[0].includes("--single-branch") &&
        c[0].includes("--no-tags"),
    );
    expect(cloneCall).toBeDefined();
  });

  test("reads parent remote URL and sets it on clone", async () => {
    await createClone(PROJECT, "ENG-1");

    // Check git remote get-url was called on parent
    const getUrlCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "remote" && c[0][2] === "get-url" && c[1]?.cwd === PROJECT,
    );
    expect(getUrlCall).toBeDefined();

    // Check git remote set-url was called on clone
    const setUrlCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "remote" &&
        c[0][2] === "set-url" &&
        c[0][3] === "origin" &&
        c[0][4] === "git@github.com:owner/repo.git",
    );
    expect(setUrlCall).toBeDefined();
  });

  test("git remote set-url failure throws", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "remote" && cmds[2] === "set-url") {
        return spawnFail("fatal: No such remote 'origin'");
      }
      return defaultSpawnHandler(cmds);
    }) as any);

    expect(createClone(PROJECT, "ENG-1")).rejects.toThrow(
      "Failed to set remote URL",
    );
  });

  test("checks remote for worktree-<name> — uses it if exists (backward compat)", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "ls-remote" && cmds.includes("worktree-ENG-1")) {
        return spawnOk("abc123\trefs/heads/worktree-ENG-1");
      }
      return defaultSpawnHandler(cmds);
    }) as any);

    const result = await createClone(PROJECT, "ENG-1");
    expect(result.branch).toBe("worktree-ENG-1");

    // Should fetch and checkout the legacy branch
    const fetchCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "fetch" && c[0].includes("worktree-ENG-1"),
    );
    expect(fetchCall).toBeDefined();
  });

  test("falls back to autopilot-<name> when legacy branch fetch fails", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "ls-remote" && cmds.includes("worktree-ENG-1")) {
        return spawnOk("abc123\trefs/heads/worktree-ENG-1");
      }
      // Legacy fetch fails
      if (cmds[1] === "fetch" && cmds.includes("worktree-ENG-1")) {
        return spawnFail("could not read from remote");
      }
      return defaultSpawnHandler(cmds);
    }) as any);

    const result = await createClone(PROJECT, "ENG-1");
    // Should fall back to new naming
    expect(result.branch).toBe("autopilot-ENG-1");
  });

  test("creates autopilot-<name> branch when no legacy branch exists", async () => {
    const result = await createClone(PROJECT, "ENG-99");
    expect(result.branch).toBe("autopilot-ENG-99");

    const checkoutCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "checkout" &&
        c[0][2] === "-b" &&
        c[0][3] === "autopilot-ENG-99",
    );
    expect(checkoutCall).toBeDefined();
  });

  test("stale clone directory is rm'd before creating", async () => {
    // First call (stale check in createClone) → true; second call (post-removal) → false.
    let calls = 0;
    existsSpy.mockImplementation(() => ++calls === 1);

    const result = await createClone(PROJECT, "ENG-2");

    expect(result.path).toContain("ENG-2");
    // rmSync should have been called for the stale directory
    expect(rmSyncSpy).toHaveBeenCalled();
  });

  test("stale clone that cannot be removed throws", async () => {
    existsSpy.mockReturnValue(true);

    expect(createClone(PROJECT, "ENG-3")).rejects.toThrow(
      "Cannot create clone",
    );
  });

  test("git clone failure throws 'Failed to create clone'", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "clone") return spawnFail("clone failed");
      return defaultSpawnHandler(cmds);
    }) as any);

    expect(createClone(PROJECT, "ENG-4")).rejects.toThrow(
      "Failed to create clone 'ENG-4'",
    );
  });
});

// ---------------------------------------------------------------------------
// createClone — fixer mode (fromBranch provided)
// ---------------------------------------------------------------------------

describe("createClone — fixer mode", () => {
  test("fetches and checks out the provided branch", async () => {
    const result = await createClone(PROJECT, "ENG-1", "feature/pr-branch");
    expect(result.branch).toBe("feature/pr-branch");

    const fetchCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "fetch" && c[0].includes("feature/pr-branch"),
    );
    expect(fetchCall).toBeDefined();

    const checkoutCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "checkout" && c[0].includes("feature/pr-branch"),
    );
    expect(checkoutCall).toBeDefined();
  });

  test("remote URL is set to GitHub URL", async () => {
    await createClone(PROJECT, "ENG-1", "feature/pr-branch");

    const setUrlCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "remote" &&
        c[0][2] === "set-url" &&
        c[0][4] === "git@github.com:owner/repo.git",
    );
    expect(setUrlCall).toBeDefined();
  });

  test("fetch failure throws", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "fetch" && cmds.includes("feature/pr")) {
        return spawnFail("no such branch");
      }
      return defaultSpawnHandler(cmds);
    }) as any);

    expect(createClone(PROJECT, "ENG-1", "feature/pr")).rejects.toThrow(
      "Failed to fetch branch",
    );
  });

  test("checkout failure throws", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "checkout" && cmds.includes("feature/pr")) {
        return spawnFail("pathspec error");
      }
      return defaultSpawnHandler(cmds);
    }) as any);

    expect(createClone(PROJECT, "ENG-1", "feature/pr")).rejects.toThrow(
      "Failed to checkout branch",
    );
  });
});

// ---------------------------------------------------------------------------
// removeClone
// ---------------------------------------------------------------------------

describe("removeClone", () => {
  test("calls rmSync with recursive and force", async () => {
    await removeClone(PROJECT, "ENG-1");

    expect(rmSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining(".claude/clones/ENG-1"),
      { recursive: true, force: true },
    );
  });

  test("never throws on rmSync failure", async () => {
    rmSyncSpy.mockImplementation(() => {
      throw new Error("permission denied");
    });
    existsSpy.mockReturnValue(true);

    await expect(removeClone(PROJECT, "ENG-1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// forceRemoveDir retry logic (exercised indirectly via removeClone)
// ---------------------------------------------------------------------------

describe("forceRemoveDir retry logic", () => {
  test("first attempt succeeds: sleep never called", async () => {
    await removeClone(PROJECT, "ENG-1");
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("retry then succeed: sleep called once with 1000ms", async () => {
    let rmAttempts = 0;
    existsSpy.mockReturnValue(true);
    rmSyncSpy.mockImplementation(() => {
      if (++rmAttempts === 1) throw new Error("locked");
      // Second attempt succeeds (no throw)
    });

    await removeClone(PROJECT, "ENG-1");

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(1000);
  });

  test("all retries exhausted: logs warning but never throws", async () => {
    existsSpy.mockReturnValue(true);
    rmSyncSpy.mockImplementation(() => {
      throw new Error("locked");
    });

    await expect(removeClone(PROJECT, "ENG-1")).resolves.toBeUndefined();
    // 4 total attempts (0, 1, 2, 3), sleep between first 3
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });

  test("directory disappears between failure and next attempt: early return", async () => {
    let rmAttempts = 0;
    rmSyncSpy.mockImplementation(() => {
      rmAttempts++;
      throw new Error("locked");
    });
    // existsSpy returns false — directory appears gone after failed rm
    existsSpy.mockReturnValue(false);

    await removeClone(PROJECT, "ENG-1");

    expect(rmAttempts).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sweepClones
// ---------------------------------------------------------------------------

describe("sweepClones", () => {
  test("removes all clones when active set is empty (default)", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2"] as any);

    await sweepClones(PROJECT);

    // rmSync called once per stale clone (by removeClone)
    expect(rmSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("skips clones in the active set", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2", "ENG-3"] as any);

    await sweepClones(PROJECT, new Set(["ENG-2"]));

    // ENG-1 and ENG-3 removed; ENG-2 is active and skipped
    expect(rmSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("continues past individual removal failures", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2"] as any);
    existsSpy.mockReturnValue(true);
    rmSyncSpy.mockImplementation(() => {
      throw new Error("locked");
    });

    await expect(sweepClones(PROJECT)).resolves.toBeUndefined();
  });

  test("does not throw when clones directory does not exist", async () => {
    readdirSyncSpy.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    });

    await expect(sweepClones(PROJECT)).resolves.toBeUndefined();
  });

  test("does nothing when clones directory is empty", async () => {
    readdirSyncSpy.mockReturnValue([] as any);

    await sweepClones(PROJECT);

    expect(rmSyncSpy).not.toHaveBeenCalled();
  });
});
