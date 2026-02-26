# Tuning

autopilot works out of the box with default settings, but tuning it for your project and workflow can significantly improve executor success rates, planning issue quality, and overall cost efficiency. This guide covers every tuning surface.

---

## Parallelism

The `executor.parallel` setting controls how many executor agents run concurrently.

### Recommended progression

| Stage | Parallel | Rationale |
|-------|----------|-----------|
| First week | 1 | Watch every PR closely. Understand executor behavior before scaling |
| Week 2-3 | 2-3 | Increase after you trust the output. Monitor for rate limit errors |
| Steady state | 3-5 | Sweet spot for most projects. Higher than 5 rarely helps |

### Rate limit considerations

Each executor agent makes multiple Claude API calls during its run. With Claude Max (subscription), you have a usage-based rate limit that replenishes over time. With API billing (per-token), the limit is higher but you pay per token.

Signs you are hitting rate limits:
- Executor agents start timing out more frequently
- Claude Code returns errors about rate limits or capacity
- Multiple agents complete but produce lower-quality output (truncated context)

**Mitigation:** Reduce `executor.parallel`, increase `executor.timeout_minutes` to give each agent more breathing room.

### Worktree considerations

Each parallel executor creates a git worktree. On large repositories, this means N copies of the working tree on disk. Make sure your machine has sufficient disk space and I/O bandwidth. Worktrees are lightweight (they share the `.git` directory), but they do consume space for the checked-out files.

---

## Model Selection

Each subsystem has its own `model` field, and sub-agents can override via their frontmatter.

| Setting | Default | Used by |
|---------|---------|---------|
| `executor.model` | `"sonnet"` | Executor agents (issue implementation) and fixer agents |
| `planning.model` | `"opus"` | CTO planning agent |
| `projects.model` | `"opus"` | Project owner agents |

Sub-agents spawned by the CTO or project owners can set their own `model:` in their agent frontmatter (e.g., Scout uses `haiku` for fast, cheap recon).

### Recommendations

- **Sonnet** for executors: Fast, cost-effective, good at following structured prompts. Best for the implement-test-commit loop.
- **Opus** for planning and project owners: Higher reasoning quality for codebase-wide analysis, project triage, and strategic decisions. Worth the extra cost since these run less frequently.
- **Haiku** for recon sub-agents (Scout, briefing): Fast and cheap for read-only exploration and data gathering.

---

## Planning Frequency

The `planning.schedule` setting controls when the planning loop runs.

### Schedule modes

| Mode | Behavior | Best for |
|------|----------|----------|
| `manual` | Only runs when you explicitly trigger it | Initial setup, learning the system |
| `when_idle` | Runs when Ready issue count drops below `min_ready_threshold` | Steady-state operation |
| `daily` | Runs once per day regardless of backlog | Teams that want predictable planning cadence |

### Recommended progression

1. **Start with `manual`.** Run the full loop and watch the dashboard. Review every issue the planning loop files to Triage.

2. **Move to `when_idle` after you trust the output.** Set `min_ready_threshold` to a value that keeps the executor fed without overwhelming Triage. Start with 5 (the default).

3. **Tune `max_issues_per_run`.** The default is 5. Lower it if you find yourself rejecting many planning issues. Raise it if the planning loop consistently files high-quality issues.

### Threshold tuning

The `min_ready_threshold` controls the trigger point:

```
Ready issues in Linear >= min_ready_threshold  -->  planning skips
Ready issues in Linear <  min_ready_threshold  -->  planning runs
```

Tuning guidance:
- Set it to roughly 2x your daily executor throughput. If the executor processes 3 issues per day, set threshold to 5-6.
- Too low (1-2): The planning loop runs too often, filing marginal issues to fill the gap.
- Too high (20+): The planning loop runs rarely, and the backlog may run dry during periods of high executor throughput.
- Observe the ratio of Triage issues you promote vs. reject. If you are rejecting more than 30%, the planning loop is running too aggressively.

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

3. **Include the implementation plan.** The planning system does this automatically. For manually created issues, list the specific files to change and what to change in each one.

4. **Decompose large issues.** If an issue touches more than 3-5 files, break it into sub-issues with dependency relations. The executor will process them in order.

5. **Specify constraints explicitly.** If the executor should use a specific library, follow a specific pattern, or avoid a specific approach, say so in the issue description.

---

## Auto-Approval

The `executor.auto_approve_labels` setting lists issue labels that are safe for automated promotion from Triage to Ready (Phase 3). When a planning-filed issue has one of these labels, it can bypass human review.

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

---

## Cost

### Claude Max (subscription)

With a Claude Max subscription, you get a usage allowance that replenishes over time. This is the most cost-effective option for steady-state usage.

Key considerations:
- Each executor run consumes a significant amount of the allowance
- The planning loop consumes more than a single executor run (full codebase scan + specialist teams)
- Rate limits apply — you may be throttled if you run too many parallel agents
- No per-token cost, so failed attempts cost the same as successful ones

### API billing (per-token)

With API billing, you pay per input and output token. This gives higher rate limits but costs scale with usage.

Expected cost ranges (these vary significantly by issue complexity and codebase size):

| Operation | Typical token usage | Approximate cost |
|-----------|-------------------|-----------------|
| Executor: small issue (S) | 50K-150K tokens | $0.50-2.00 |
| Executor: medium issue (M) | 150K-400K tokens | $2.00-6.00 |
| Executor: large issue (L) | 400K-1M+ tokens | $6.00-15.00+ |
| Planning: single run | 200K-800K tokens | $3.00-12.00 |

### Cost optimization

1. **Write smaller issues.** The strongest lever. A small issue uses 3-5x fewer tokens than a large one, and succeeds more often.

2. **Tune executor timeout.** The default 30 minutes is generous. If most of your issues complete in 10-15 minutes, reducing the timeout to 20 minutes prevents runaway costs.

3. **Use model selection wisely.** Use Sonnet for executors (fast, cheap) and Opus only for planning where reasoning quality matters more.

4. **Lower planning issue cap.** `max_issues_per_run: 3` instead of 5 reduces planning token usage proportionally.

5. **Tune planning timeout.** The default `timeout_minutes: 90` is generous for the CTO team-based investigation. Reduce if planning runs consistently finish faster.

---

## Dashboard Monitoring

The web dashboard at `http://localhost:7890` provides real-time visibility. Use it to:

- **Watch agent activity** — see tool calls, text output, and errors as they happen
- **Spot stuck agents** — if an agent has been running for a long time with repetitive tool calls, the issue may be too complex
- **Track cost** — completed agents show cost and turn count
- **Monitor queue** — see how many Ready issues remain and how many agents are running

The `/api/status` endpoint returns JSON for programmatic monitoring.

---

## When Things Go Wrong

### Executor is stuck (timing out)

**Symptoms:** Issues move to Blocked with "timed out" comments. The worktree branch may have partial changes.

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| Issue is too large or complex | Break it into smaller sub-issues |
| Test command hangs (watch mode, interactive prompt) | Fix `project.test_command` to run non-interactively |
| Claude is stuck in a validation loop | Check the issue. If tests keep failing, the acceptance criteria may be unrealistic |
| Timeout is too short | Increase `executor.timeout_minutes` (but first check if the issue is simply too large) |

### Planning files bad issues

**Symptoms:** Many Triage issues are vague, duplicative, or not worth implementing.

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| CLAUDE.md lacks detail | Add more context about architecture, conventions, and priorities to CLAUDE.md |
| Max issues too high | Lower `max_issues_per_run` |
| CTO prompt needs tuning | Customize `prompts/cto.md` |
| Specialist prompts need tuning | Customize specialist prompts in `prompts/` (scout, security-analyst, quality-engineer, architect) |

---

## Prompt Tuning

The prompts in `prompts/` are the primary tuning surface for behavior quality.

### Executor prompt (prompts/executor.md)

The executor prompt has 6 phases. Each phase can be independently tuned. See the prompt file for details.

### Planning prompts (prompts/cto.md and specialists)

Customize the CTO agent's investigation strategy and issue filing criteria. The specialist prompts (`scout.md`, `security-analyst.md`, `quality-engineer.md`, `architect.md`) and the issue planner prompt (`issue-planner.md`) can also be tuned independently.

### Testing prompt changes

After modifying a prompt, start the loop and watch the dashboard:

```bash
bun run start /path/to/project
```

Review the agent activity in real time. Check Linear for the issues filed. Iterate.

---

## Tuning Checklist

Use this as a periodic review checklist:

- [ ] **Executor success rate**: What percentage of Ready issues reach Done vs. Blocked? Target: >80% for small issues
- [ ] **Planning acceptance rate**: What percentage of Triage issues get promoted to Ready? Target: >70%
- [ ] **Time to completion**: How long does the executor take per issue? If consistently near the timeout, issues may be too large
- [ ] **Cost per issue**: Is the per-issue cost in line with expectations? Check the dashboard
- [ ] **CLAUDE.md freshness**: Does CLAUDE.md reflect the current state of the codebase?
- [ ] **Prompt effectiveness**: Have you reviewed executor and planning output recently?
- [ ] **Parallelism**: Are you hitting rate limits? Adjust `executor.parallel` as needed
- [ ] **Planning threshold**: Is the Ready backlog staying in a healthy range?
