# Git Workflows for Agent Types

## Common Anti-Patterns — Do NOT Do These

Real agents have been observed doing all of the following when git operations fail. Every one of these is wrong and wastes turns. **If a standard git command fails, escalate — do not debug git internals.**

### Never use git plumbing commands

Do not use `git write-tree`, `git commit-tree`, `git update-ref`, `git hash-object`, `git read-tree`, `git symbolic-ref`, or `git cat-file` to work around failures. These are internal git commands that bypass safety checks and can corrupt the repository state.

### Never probe filesystem writability

Do not run `touch .git/objects/test-write`, `strace git commit`, or `ls -la .git/` to debug why git operations fail. The sandbox configuration is not something to work around.

### Never set GIT_* environment variables

Do not set `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_TMPDIR`, or `GIT_TRACE` to work around failures. These override git's internal behavior and create unpredictable state.

### Never modify git config to fix failures

Do not run `git config core.tmpdir`, `git config core.tempdir`, or change `commit.gpgsign` to work around issues. The environment is configured correctly.

### Never bypass git with the GitHub API

Do not use `github/push_files`, `github/create_branch`, or `github/create_or_update_file` to push code. Always use standard `git commit` + `git push`. The GitHub API approach creates commits with wrong author metadata and bypasses local validation.

### Never spawn sub-agents for git operations

Do not spawn a Task sub-agent to "push files to GitHub" or "debug git". Git operations should be straightforward. If they aren't, escalate the issue.

**The rule is simple**: Use `git add`, `git commit`, `git push`, `git fetch`, `git merge`, `git status`, `git log`, `git diff`. If one of these fails, try once more. If it fails again, report the error and escalate. Do not spend more than 2 turns on git problems.

---

## Executor Workflow

The executor creates new work on a fresh branch. This is the simplest git workflow.

### Step 1: Implement

Write code, run tests, lint, format. Standard development work.

### Step 2: Stage specific files

```bash
git add src/file1.ts src/file2.ts src/tests/file1.test.ts
```

Never use `git add -A` or `git add .`. Always list files explicitly.

### Step 3: Rebase on latest main (before first push only)

```bash
git fetch origin main && git rebase origin/main
```

This is safe because the branch has never been pushed. If conflicts arise during rebase, resolve them, then re-run validation.

### Step 4: Commit

```bash
git commit -m "ISSUE-ID: concise description"
```

If the commit fails due to **GPG/SSH signing** (e.g. `error: gpg failed to sign the data`, or a signing tool timeout), retry with `--no-gpg-sign`:

```bash
git commit --no-gpg-sign -m "ISSUE-ID: concise description"
```

The host environment may have commit signing enabled globally (e.g. 1Password SSH agent) which can time out in a headless/automated context. Falling back to unsigned commits is acceptable — the CI system validates code quality, not commit signatures.

For any other commit failure, try once more without investigating internals. If it fails twice, report the error and block the issue.

### Step 5: Push

```bash
git push -u origin <branch-name>
```

The branch name is provided in the prompt template. Use it exactly.

### Step 6: Create PR

Use the GitHub MCP `create_pull_request` tool. Never use `gh` CLI.

---

## Fixer Workflow

The fixer repairs a failing PR on an existing branch. This involves more complex git operations.

### Step 1: Sync to remote state

```bash
git fetch origin <branch> && git reset --hard origin/<branch>
```

This is the **only** time `git reset --hard` is acceptable. It ensures the clone matches the remote branch exactly before starting work.

### Step 2: For CI failures

1. Read the CI failure logs via GitHub MCP
2. Reproduce the failure locally
3. Apply the minimal fix
4. Run validation (typecheck, lint, format, tests)
5. Commit and push

### Step 3: For merge conflicts

**Always use merge, never rebase.** Rebase rewrites history and requires force-push.

```bash
git fetch origin main
git merge origin/main
```

If conflicts arise:
1. Run `git status` to see conflicting files
2. Open each conflicting file and read BOTH sides of the conflict markers
3. Resolve by preserving the intent of both sides
4. Stage each resolved file individually: `git add src/resolved-file.ts`
5. Complete the merge: `git commit --no-edit`

**Conflict resolution rules:**
- Read the full context around each conflict — do not just pick one side
- Preserve the intent of upstream changes (they are correct)
- Preserve the intent of the branch changes (they are also correct)
- Merge them together logically — this may mean keeping both additions, or combining modified functions
- Never use `git checkout --theirs` or `git checkout --ours` on whole files
- Never delete upstream code to make the branch "win"
- If a conflict is too complex (both sides rewrote the same function), escalate

### Step 4: Push the fix

```bash
git add <specific files>
git commit -m "ISSUE-ID: fix <failure-type>"
git push origin HEAD:<branch>
```

If the commit fails due to signing (GPG/SSH timeout), retry with `--no-gpg-sign`.

If push fails due to diverged history:
```bash
git pull --rebase origin <branch>
git push origin HEAD:<branch>
```

If the pull --rebase also fails, escalate. Do not force-push.

---

## Review-Responder Workflow

Nearly identical to the fixer workflow. The setup phase is the same (fetch + reset --hard). The push phase is the same. The only difference is the middle — addressing review comments instead of fixing CI failures.

---

## When to Escalate

Stop and block the issue with a clear explanation if:

- `git commit` fails twice for the same reason
- `git push` fails after a `git pull --rebase` retry
- A merge conflict involves both sides rewriting the same function in incompatible ways
- Any git command produces an error not mentioned in this guide
- The branch appears to be in a detached HEAD state unexpectedly

**Escalation means**: Add a comment to the Linear issue explaining the exact error, what was attempted, and why it couldn't be resolved. Move the issue to Blocked. Do not attempt workarounds.
