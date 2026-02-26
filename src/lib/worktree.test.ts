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

import { createWorktree, removeWorktree, sweepWorktrees } from "./worktree";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SpawnResult = ReturnType<typeof Bun.spawnSync>;

function spawnOk(): SpawnResult {
  return {
    exitCode: 0,
    stdout: Buffer.from(""),
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
// spyOn on the node:fs namespace object intercepts calls made by worktree.ts
// without using mock.module (which causes permanent leakage — Bun bug #7823).
let existsSpy: ReturnType<typeof spyOn<typeof fs, "existsSync">>;
let rmSyncSpy: ReturnType<typeof spyOn<typeof fs, "rmSync">>;
let readdirSyncSpy: ReturnType<typeof spyOn<typeof fs, "readdirSync">>;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;
let sleepSpy: ReturnType<typeof spyOn<typeof Bun, "sleep">>;

beforeEach(() => {
  existsSpy = spyOn(fs, "existsSync").mockReturnValue(false);
  rmSyncSpy = spyOn(fs, "rmSync").mockReturnValue(undefined as unknown as void);
  readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([] as any);
  spawnSpy = spyOn(Bun, "spawnSync").mockReturnValue(spawnOk());
  sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(
    undefined as unknown as void,
  );
});

afterEach(() => mock.restore());

// ---------------------------------------------------------------------------
// createWorktree — executor mode (no fromBranch)
// ---------------------------------------------------------------------------

describe("createWorktree — executor mode", () => {
  test("returns absolute path containing .claude/worktrees/<name>", async () => {
    const result = await createWorktree(PROJECT, "ENG-1");
    expect(result).toContain(".claude/worktrees/ENG-1");
  });

  test("creates fresh branch named worktree-<name>", async () => {
    await createWorktree(PROJECT, "ENG-42");

    const addCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "worktree" && c[0][2] === "add" && c[0].includes("-b"),
    );
    expect(addCall).toBeDefined();
    const bIdx = addCall![0].indexOf("-b");
    expect(addCall![0][bIdx + 1]).toBe("worktree-ENG-42");
  });

  test("stale worktree is cleaned up and creation proceeds", async () => {
    // First call (stale check in createWorktree) → true; second call (post-removal) → false.
    let calls = 0;
    existsSpy.mockImplementation(() => ++calls === 1);

    const result = await createWorktree(PROJECT, "ENG-2");

    expect(result).toContain("ENG-2");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("stale worktree cleanup deletes the branch reference (no fromBranch)", async () => {
    let calls = 0;
    existsSpy.mockImplementation(() => ++calls === 1);

    await createWorktree(PROJECT, "ENG-5");

    const branchDelete = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "branch" &&
        c[0][2] === "-D" &&
        c[0][3] === "worktree-ENG-5",
    );
    expect(branchDelete).toBeDefined();
  });

  test("stale worktree that cannot be removed throws 'Cannot create worktree'", async () => {
    // existsSync always returns true — directory never disappears.
    existsSpy.mockReturnValue(true);

    expect(createWorktree(PROJECT, "ENG-3")).rejects.toThrow(
      "Cannot create worktree",
    );
  });

  test("worktree add failure throws 'Failed to create worktree'", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "add")
        return spawnFail("branch in use");
      return spawnOk();
    }) as any);

    expect(createWorktree(PROJECT, "ENG-4")).rejects.toThrow(
      "Failed to create worktree 'ENG-4'",
    );
  });
});

// ---------------------------------------------------------------------------
// createWorktree — fixer mode (fromBranch provided)
// ---------------------------------------------------------------------------

describe("createWorktree — fixer mode", () => {
  test("fetches the PR branch from origin", async () => {
    await createWorktree(PROJECT, "ENG-1", "feature/pr-branch");

    const fetchCall = spawnSpy.mock.calls.find((c) => c[0][1] === "fetch");
    expect(fetchCall).toBeDefined();
    expect(fetchCall![0]).toContain("feature/pr-branch");
  });

  test("creates worktree from existing branch without -b flag", async () => {
    await createWorktree(PROJECT, "ENG-1", "feature/pr-branch");

    const addCall = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "worktree" && c[0][2] === "add" && !c[0].includes("-b"),
    );
    expect(addCall).toBeDefined();
    expect(addCall![0]).toContain("feature/pr-branch");
  });

  test("stale cleanup does NOT delete branch when fromBranch is set", async () => {
    let calls = 0;
    existsSpy.mockImplementation(() => ++calls === 1);

    await createWorktree(PROJECT, "ENG-1", "feature/pr-branch");

    const branchDelete = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "branch" && c[0][2] === "-D",
    );
    expect(branchDelete).toBeUndefined();
  });

  test("worktree add failure throws", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "add")
        return spawnFail("no such branch");
      return spawnOk();
    }) as any);

    expect(createWorktree(PROJECT, "ENG-1", "feature/pr")).rejects.toThrow(
      "Failed to create worktree 'ENG-1'",
    );
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  test("removes worktree directory and deletes branch by default", async () => {
    await removeWorktree(PROJECT, "ENG-1");

    const removeCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "worktree" && c[0][2] === "remove",
    );
    expect(removeCall).toBeDefined();

    const branchDelete = spawnSpy.mock.calls.find(
      (c) =>
        c[0][1] === "branch" &&
        c[0][2] === "-D" &&
        c[0][3] === "worktree-ENG-1",
    );
    expect(branchDelete).toBeDefined();
  });

  test("keepBranch=true skips branch deletion", async () => {
    await removeWorktree(PROJECT, "ENG-1", { keepBranch: true });

    const branchDelete = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "branch" && c[0][2] === "-D",
    );
    expect(branchDelete).toBeUndefined();
  });

  test("branch deletion failure is non-fatal (does not throw)", async () => {
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "branch" && cmds[2] === "-D")
        return spawnFail("branch not found");
      return spawnOk();
    }) as any);

    await expect(removeWorktree(PROJECT, "ENG-1")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// forceRemoveDir retry logic (exercised indirectly via removeWorktree)
// ---------------------------------------------------------------------------

describe("forceRemoveDir retry logic", () => {
  test("first attempt succeeds: sleep never called", async () => {
    // Default spawnSpy returns success — git worktree remove succeeds immediately.
    await removeWorktree(PROJECT, "ENG-1");

    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("retry then succeed: sleep called once with 1000ms", async () => {
    let removeAttempts = 0;
    // existsSync returns true so the "directory gone" early-exit doesn't fire.
    existsSpy.mockReturnValue(true);
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "remove") {
        return ++removeAttempts === 1 ? spawnFail("locked") : spawnOk();
      }
      return spawnOk();
    }) as any);

    await removeWorktree(PROJECT, "ENG-1");

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(1000);
  });

  test("all retries exhausted: falls back to rmSync", async () => {
    // All git worktree remove attempts fail; directory never disappears.
    existsSpy.mockReturnValue(true);
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "remove")
        return spawnFail("locked");
      return spawnOk();
    }) as any);

    await removeWorktree(PROJECT, "ENG-1");

    expect(rmSyncSpy).toHaveBeenCalled();
    // Attempts 0, 1, 2 each sleep before the next retry; attempt 3 goes to rmSync directly.
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });

  test("rmSync failure is non-fatal (does not throw)", async () => {
    existsSpy.mockReturnValue(true);
    rmSyncSpy.mockImplementation(() => {
      throw new Error("permission denied");
    });
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "remove")
        return spawnFail("locked");
      return spawnOk();
    }) as any);

    await expect(removeWorktree(PROJECT, "ENG-1")).resolves.toBeUndefined();
  });

  test("directory disappears between git-remove failure and next attempt: early return", async () => {
    let removeAttempts = 0;
    // git worktree remove fails, but existsSync returns false → directory already gone.
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "remove") {
        removeAttempts++;
        return spawnFail("locked");
      }
      return spawnOk();
    }) as any);
    // existsSpy defaults to returning false — directory appears gone after failed remove.

    await removeWorktree(PROJECT, "ENG-1");

    expect(removeAttempts).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sweepWorktrees
// ---------------------------------------------------------------------------

describe("sweepWorktrees", () => {
  test("removes all worktrees when active set is empty (default)", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2"] as any);

    await sweepWorktrees(PROJECT);

    const removeCalls = spawnSpy.mock.calls.filter(
      (c) => c[0][1] === "worktree" && c[0][2] === "remove",
    );
    // One git worktree remove call per stale worktree
    expect(removeCalls.length).toBe(2);
  });

  test("skips worktrees in the active set", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2", "ENG-3"] as any);

    await sweepWorktrees(PROJECT, new Set(["ENG-2"]));

    const removeCalls = spawnSpy.mock.calls.filter(
      (c) => c[0][1] === "worktree" && c[0][2] === "remove",
    );
    // ENG-1 and ENG-3 removed; ENG-2 is active and skipped
    expect(removeCalls.length).toBe(2);
  });

  test("continues past individual removal failures", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1", "ENG-2"] as any);
    // All git worktree remove attempts fail; directory never disappears
    existsSpy.mockReturnValue(true);
    spawnSpy.mockImplementation(((cmds: string[]) => {
      if (cmds[1] === "worktree" && cmds[2] === "remove")
        return spawnFail("locked");
      return spawnOk();
    }) as any);

    await expect(sweepWorktrees(PROJECT)).resolves.toBeUndefined();
    // rmSync called once per stale worktree (fallback after max retries)
    expect(rmSyncSpy).toHaveBeenCalledTimes(2);
  });

  test("does not throw when worktrees directory does not exist", async () => {
    readdirSyncSpy.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      });
    });

    await expect(sweepWorktrees(PROJECT)).resolves.toBeUndefined();
  });

  test("calls git worktree prune after sweep", async () => {
    readdirSyncSpy.mockReturnValue(["ENG-1"] as any);

    await sweepWorktrees(PROJECT);

    const pruneCall = spawnSpy.mock.calls.find(
      (c) => c[0][1] === "worktree" && c[0][2] === "prune",
    );
    expect(pruneCall).toBeDefined();
  });

  test("does nothing when worktrees directory is empty", async () => {
    readdirSyncSpy.mockReturnValue([] as any);

    await sweepWorktrees(PROJECT);

    const removeCalls = spawnSpy.mock.calls.filter(
      (c) => c[0][1] === "worktree" && c[0][2] === "remove",
    );
    expect(removeCalls.length).toBe(0);
  });
});
