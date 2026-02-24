# Tuning

claude-autopilot works out of the box with default settings, but tuning it for your project and workflow can significantly improve executor success rates, auditor issue quality, and overall cost efficiency. This guide covers every tuning surface.

---

## Parallelism

The `executor.parallel` setting controls how many executor instances run concurrently (used by n8n orchestration in Phase 2+).

### Recommended progression

| Stage | Parallel | Rationale |
|-------|----------|-----------|
| First week | 1 | Watch every PR closely. Understand executor behavior before scaling |
| Week 2-3 | 2-3 | Increase after you trust the output. Monitor for rate limit errors |
| Steady state | 3-5 | Sweet spot for most projects. Higher than 5 rarely helps |

### Rate limit considerations

Each executor instance makes multiple Claude Code API calls during its run. With Claude Max (subscription), you have a usage-based rate limit that replenishes over time. With API billing (per-token), the limit is higher but you pay per token.

Signs you are hitting rate limits:
- Executor instances start timing out more frequently
- Claude Code returns errors about rate limits or capacity
- Multiple executors complete but produce lower-quality output (truncated context)

**Mitigation:** Reduce `executor.parallel`, increase `executor.timeout_minutes` to give each instance more breathing room, or stagger executor start times in n8n.

### Worktree considerations

Each parallel executor creates a git worktree. On large repositories, this means N copies of the working tree on disk. Make sure your machine has sufficient disk space and I/O bandwidth. Worktrees are lightweight (they share the `.git` directory), but they do consume space for the checked-out files.

---

## Auditor Frequency

The `auditor.schedule` setting controls when the auditor runs.

### Schedule modes

| Mode | Behavior | Best for |
|------|----------|----------|
| `manual` | Only runs when you explicitly call `bun run auditor` | Initial setup, learning the system |
| `when_idle` | Runs when Ready issue count drops below `min_ready_threshold` | Steady-state operation |
| `daily` | Runs once per day regardless of backlog | Teams that want predictable auditor cadence |

### Recommended progression

1. **Start with `manual`.** Run the auditor yourself a few times. Review every issue it files to Triage. This is where you calibrate your trust in the auditor's judgment.

2. **Move to `when_idle` after you trust the output.** Set `min_ready_threshold` to a value that keeps the executor fed without overwhelming Triage. Start with 5 (the default). If you find yourself promoting issues from Triage faster than the executor processes them, increase the threshold.

3. **Tune `max_issues_per_run`.** The default is 10. Lower it if you find yourself rejecting many auditor issues (the auditor is filing low-quality issues to hit the cap). Raise it if the auditor consistently files high-quality issues and you want more.

### Threshold tuning

The `min_ready_threshold` controls the trigger point:

```
Ready issues in Linear >= min_ready_threshold  -->  auditor skips
Ready issues in Linear <  min_ready_threshold  -->  auditor runs
```

Tuning guidance:
- Set it to roughly 2x your daily executor throughput. If the executor processes 3 issues per day, set threshold to 5-6.
- Too low (1-2): The auditor runs too often, filing marginal issues to fill the gap.
- Too high (20+): The auditor runs rarely, and the backlog may run dry during periods of high executor throughput.
- Observe the ratio of Triage issues you promote vs. reject. If you are rejecting more than 30%, the auditor is running too aggressively.

---

## Issue Granularity

The single most impactful tuning lever for executor success rate is issue granularity. Smaller, more precisely scoped issues have dramatically higher success rates.

### What "small" means

| Size | Description | Executor success rate |
|------|-------------|----------------------|
| S (Small) | 1-2 files changed, straightforward, <1hr | ~90%+ |
| M (Medium) | 3-5 files changed, some nuance, 1-3hrs | ~60-75% |
| L (Large) | 5+ files changed, significant complexity, 3-8hrs | ~30-50% |

### How to write good executor issues

1. **One concern per issue.** "Add input validation to the /users endpoint" is good. "Improve the users module" is bad.

2. **Include acceptance criteria that are machine-verifiable.** The executor uses these to know when it is done. "Running `npm test` passes" is verifiable. "The code is well-structured" is not.

3. **Include the implementation plan.** The auditor does this automatically. For manually created issues, list the specific files to change and what to change in each one.

4. **Decompose large issues.** If an issue touches more than 3-5 files, break it into sub-issues with dependency relations. The executor will process them in order.

5. **Specify constraints explicitly.** If the executor should use a specific library, follow a specific pattern, or avoid a specific approach, say so in the issue description.

### What the auditor does well

The auditor's Planner/Verifier pipeline is specifically designed to produce small, concrete issues. If you find yourself manually creating large, vague issues, consider writing a brief description and letting the auditor decompose it instead.

---

## Auto-Approval

The `executor.auto_approve_labels` setting lists issue labels that are safe for automated promotion from Triage to Ready (Phase 3). When an auditor-filed issue has one of these labels, it can bypass human review.

### Safe labels to start with

| Label | Risk level | Why it is safe |
|-------|-----------|---------------|
| `documentation` | Very low | Changes to docs and comments. Cannot break functionality |
| `test-coverage` | Low | Adds tests for existing behavior. Should not change production code |
| `dependency-update` | Low-medium | Updates dependencies. Tests catch regressions |

### Labels to keep manual

| Label | Risk level | Why it needs review |
|-------|-----------|-------------------|
| `security` | High | Security changes need human judgment about threat model |
| `performance` | Medium | Performance changes can have subtle side effects |
| `error-handling` | Medium | Changing error handling can alter user-facing behavior |
| `code-quality` | Medium | Refactoring can introduce subtle bugs |

### Progression

1. **Start with no auto-approval.** Review every Triage issue manually.
2. **Enable `documentation` first.** Monitor for a week. If all auto-approved documentation issues are successful, proceed.
3. **Add `test-coverage`.** Monitor for issues where the executor modifies production code to make tests pass (it should not, but verify).
4. **Add `dependency-update` cautiously.** Only if your test suite catches regressions reliably.
5. **Never auto-approve `security` or unknown labels.**

```yaml
# Conservative (recommended starting point)
executor:
  auto_approve_labels: []

# After building trust
executor:
  auto_approve_labels:
    - documentation
    - test-coverage

# Aggressive (only with comprehensive test suites)
executor:
  auto_approve_labels:
    - documentation
    - test-coverage
    - dependency-update
    - code-quality
```

---

## Cost

### Claude Max (subscription)

With a Claude Max subscription, you get a usage allowance that replenishes over time. This is the most cost-effective option for steady-state usage.

Key considerations:
- Each executor run consumes a significant amount of the allowance (reading issue, reading code, implementing, testing, pushing)
- The auditor consumes more than a single executor run (full codebase scan + subagent teams)
- Rate limits apply -- you may be throttled if you run too many parallel executors
- No per-token cost, so failed attempts cost the same as successful ones

Recommendation: Start with Claude Max. If you consistently hit rate limits with 3+ parallel executors, consider API billing for the executor and keep Claude Max for interactive use.

### API billing (per-token)

With API billing, you pay per input and output token. This gives higher rate limits but costs scale with usage.

Expected cost ranges (these vary significantly by issue complexity and codebase size):

| Operation | Typical token usage | Approximate cost |
|-----------|-------------------|-----------------|
| Executor: small issue (S) | 50K-150K tokens | $0.50-2.00 |
| Executor: medium issue (M) | 150K-400K tokens | $2.00-6.00 |
| Executor: large issue (L) | 400K-1M+ tokens | $6.00-15.00+ |
| Auditor: single run | 200K-800K tokens | $3.00-12.00 |

These are rough estimates. Actual costs depend on:
- Codebase size (more files = more context tokens)
- Issue complexity (more iterations = more tokens)
- Test/lint cycle count (each retry adds tokens)
- Auditor scope (more scan dimensions = more tokens)

### Cost optimization

1. **Write smaller issues.** The strongest lever. A small issue uses 3-5x fewer tokens than a large one, and succeeds more often (so you do not pay for retries).

2. **Tune executor timeout.** The default 30 minutes is generous. If most of your issues complete in 10-15 minutes, reducing the timeout to 20 minutes prevents runaway costs on stuck issues.

3. **Limit auditor scope.** Remove scan dimensions you do not care about:

```yaml
auditor:
  scan_dimensions:
    - test-coverage
    - security
    # Removed: error-handling, performance, code-quality,
    #          dependency-health, documentation
```

4. **Lower auditor issue cap.** `max_issues_per_run: 5` instead of 10 reduces auditor token usage proportionally.

5. **Increase `min_ready_threshold`.** Running the auditor less often saves tokens. A threshold of 10 instead of 5 means the auditor runs roughly half as often.

---

## When Things Go Wrong

### Executor is stuck (timing out)

**Symptoms:** Issues move to Blocked with "timed out after N minutes" comments. The worktree branch may have partial changes.

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| Issue is too large or complex | Break it into smaller sub-issues |
| Test command hangs (watch mode, interactive prompt) | Fix `project.test_command` to run non-interactively |
| Lint command hangs | Fix `project.lint_command` similarly |
| Claude is stuck in a validation loop | Check the issue. If tests keep failing, the acceptance criteria may be unrealistic. Revise the issue |
| Timeout is too short | Increase `executor.timeout_minutes` (but first check if the issue is simply too large) |
| External service dependency | If tests require a running database or API, make sure the test environment is available |

**Recovery:** The timed-out issue moves to Blocked. Review the partial work on the worktree branch (`git log autopilot/ISSUE-ID`). Either simplify the issue and re-promote to Ready, or complete the implementation manually using the partial work as a starting point.

### Auditor files bad issues

**Symptoms:** Many Triage issues are vague, duplicative, or not worth implementing. You find yourself rejecting more than 30% of auditor output.

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| CLAUDE.md lacks detail | Add more context about architecture, conventions, and priorities to CLAUDE.md |
| Scan dimensions too broad | Remove dimensions that generate low-value issues for your project |
| Max issues too high | Lower `max_issues_per_run`. The auditor files lower-quality issues to fill the quota |
| Auditor prompt needs tuning | Customize `prompts/auditor.md` (see Prompt Tuning below) |
| No Agent Teams | Set `auditor.use_agent_teams: true`. The Verifier catches bad issues before they are filed |

**Recovery:** Review Triage carefully during the first few weeks. Reject bad issues (close them in Linear). The auditor does not learn from rejections automatically, but you can improve output by tuning the prompt and CLAUDE.md.

### Merge conflicts

**Symptoms:** Executor opens a PR with merge conflicts. Or, two PRs touch the same files and cannot both be merged.

**Causes and fixes:**

Worktree isolation prevents most conflicts. Each executor works on its own branch from the latest main. However, conflicts can still happen when:

| Cause | Fix |
|-------|-----|
| Two issues modify the same file | Add `related` relations in Linear. The auditor does this automatically. Merge one PR first, then re-run the executor for the second issue |
| Issue branch is stale (main has diverged) | The executor creates branches from the latest main at start time. If execution takes a long time, main may have moved. Reduce timeout or ensure issues are small enough to complete quickly |
| Overlapping issues in the auditor output | The auditor's self-review phase checks for file conflicts and adds relations. If it misses one, add the relation manually in Linear |

**Recovery:** Close the conflicting PR. Re-promote the issue to Ready. The executor will re-run from the latest main and produce a conflict-free implementation.

### Executor produces incorrect implementation

**Symptoms:** PR is opened but the implementation does not match the acceptance criteria. Tests may pass but the behavior is wrong.

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| Acceptance criteria are ambiguous | Rewrite with machine-verifiable criteria. "Endpoint returns 404 when user not found" not "Error handling is correct" |
| CLAUDE.md is missing key context | Add the relevant conventions and gotchas to CLAUDE.md |
| Issue is missing implementation plan | Add a step-by-step plan to the issue description. The auditor does this automatically; manual issues often lack it |
| Codebase patterns are inconsistent | Claude follows the patterns it sees. If the codebase has multiple conflicting patterns, specify which one to follow in the issue or CLAUDE.md |

---

## Prompt Tuning

The prompts in `prompts/` are the primary tuning surface for behavior quality. Modify them to adapt the system to your project's specific needs.

### Executor prompt (prompts/executor.md)

The executor prompt has 6 phases. Each phase can be independently tuned.

**Phase 1 (Understand):** If the executor frequently misunderstands issues, add more guidance about how to interpret your issue format. For example, if your team uses a specific section for implementation hints, tell the executor to look for it.

**Phase 2 (Plan):** If the executor makes over-broad changes, strengthen the constraints:

```markdown
Constraints:
- NEVER modify more than 5 files in a single issue
- NEVER add new dependencies without explicit approval in the issue
- NEVER change the project's public API unless the issue specifically requires it
```

**Phase 3 (Implement):** Add project-specific coding rules:

```markdown
### Project-specific rules
- Always use the `AppError` class from `src/lib/errors.ts` for error responses
- Database queries must use the query builder in `src/lib/db.ts`, never raw SQL
- All new API endpoints must have OpenAPI annotations
```

**Phase 4 (Validate):** If your project has additional validation steps beyond test and lint:

```markdown
### Type check
\```
npx tsc --noEmit
\```

### Integration tests
\```
npm run test:integration
\```
```

**Phase 5 (Commit and Push):** If your team has specific PR conventions, update the PR body template.

**Phase 6 (Update Linear):** If you want different information in the Linear comments (e.g., token usage, execution time), add instructions here.

### Auditor prompt (prompts/auditor.md)

**Phase 1 (Discover):** Customize scan dimensions for your project. Remove irrelevant ones. Add project-specific dimensions:

```markdown
### API Contract Consistency
- REST endpoints that don't follow the project's API versioning scheme
- Response shapes that deviate from the standard envelope format
- Missing pagination on list endpoints that could return unbounded results
```

**Phase 2 (Deep Planning):** If the Planner produces plans that are too vague or too detailed for your project, adjust the Planner subagent prompt (`prompts/planner.md`).

**Phase 3 (Synthesize and File):** Customize the issue template to match your team's conventions. If your team uses different label names, update the Labels section.

**Phase 4 (Self-Review):** Add project-specific review checks:

```markdown
6. **Priority alignment**: Verify that security and reliability issues are prioritized
   over code quality and documentation issues
7. **Scope check**: Ensure no filed issue requires changes to the deployment pipeline
   or infrastructure (these need human planning)
```

### Subagent prompts

**Planner (prompts/planner.md):** If plans are too detailed (wasting tokens) or too vague (executor gets stuck), adjust the level of specificity required. The "Good plan step" and "Bad plan step" examples at the bottom of the prompt set the calibration bar.

**Verifier (prompts/verifier.md):** If the Verifier is too strict (rejecting reasonable plans) or too lenient (approving plans with obvious gaps), adjust the verdict criteria. You can also add project-specific feasibility checks.

**Security Reviewer (prompts/security-reviewer.md):** If the Security Reviewer flags too many false positives for your project's threat model, narrow the review scope. For example, if your project is an internal tool with no public endpoints, you can deprioritize the "New Attack Surface" section.

### Testing prompt changes

After modifying a prompt:

1. Run the auditor manually: `bun run auditor /path/to/project`
2. Review the Triage issues it files. Are they better or worse than before?
3. Run the executor on a known issue: `bun run executor /path/to/project once`
4. Review the PR. Did the prompt change improve the output?

Keep a record of prompt changes and their effects. Prompt tuning is iterative -- small changes compound over time.

---

## Tuning Checklist

Use this as a periodic review checklist:

- [ ] **Executor success rate**: What percentage of Ready issues reach Done vs. Blocked? Target: >80% for small issues
- [ ] **Auditor acceptance rate**: What percentage of Triage issues get promoted to Ready? Target: >70%
- [ ] **Time to completion**: How long does the executor take per issue? If consistently near the timeout, issues may be too large
- [ ] **Merge conflict rate**: How often do PRs have conflicts? If frequent, check for overlapping issues
- [ ] **Cost per issue**: Is the per-issue cost in line with expectations? If not, check issue granularity
- [ ] **CLAUDE.md freshness**: Does CLAUDE.md reflect the current state of the codebase? Update after major refactors
- [ ] **Prompt effectiveness**: Have you reviewed executor and auditor output recently? Tune prompts based on patterns you see
- [ ] **Protected paths**: Are all sensitive files listed in `project.protected_paths`?
- [ ] **Parallelism**: Are you hitting rate limits? Adjust `executor.parallel` as needed
- [ ] **Auditor threshold**: Is the Ready backlog staying in a healthy range (not empty, not overflowing)?
