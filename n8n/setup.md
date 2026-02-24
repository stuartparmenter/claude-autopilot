# n8n Workflow Setup Guide

This guide covers how to import and configure the Claude Autopilot workflows in n8n. These workflows automate the executor (picks up Linear issues and runs Claude Code) and auditor (scans codebases and files new issues).

---

## Prerequisites

### On the n8n host machine

1. **n8n instance** (v1.30+ recommended) -- self-hosted or n8n Cloud.
   - Self-hosted: `npx n8n` or Docker. See https://docs.n8n.io/hosting/
   - The Execute Command node must be enabled (it is by default in self-hosted; n8n Cloud does not support it -- you need self-hosted).

2. **Claude CLI** installed and authenticated.
   ```bash
   # Install
   npm install -g @anthropic-ai/claude-code

   # Authenticate (interactive, one-time)
   claude
   ```
   Verify: `claude --version` should print a version number.

3. **Bun** runtime (required by the auditor workflow and the autopilot scripts).
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```
   Verify: `bun --version`

4. **claude-autopilot** repository cloned and dependencies installed:
   ```bash
   git clone <your-repo-url> ~/claude-autopilot
   cd ~/claude-autopilot
   bun install
   ```

5. **Linear API key** with read/write access.
   - Create one at: https://linear.app/settings/api
   - Format: `lin_api_...`
   - The key must have permissions to read issues, update issue state, create comments, and create issues.

6. **Environment variables** on the host (for the `bun run auditor` command):
   ```bash
   export LINEAR_API_KEY="lin_api_your_key_here"
   ```
   Add this to your shell profile (`~/.bashrc`, `~/.zshrc`) or use n8n's environment variable support.

---

## Importing the Workflows

1. Open your n8n instance in a browser.
2. Go to **Workflows** in the left sidebar.
3. Click the **"..."** menu (top-right) and select **Import from File**.
4. Select `executor-workflow.json` and click **Import**.
5. Repeat for `auditor-workflow.json`.

Both workflows will appear in your workflow list tagged with `claude-autopilot`.

---

## Finding Your Linear UUIDs

The workflows require Linear UUIDs for your team and workflow states. Here is how to find them.

### Option A: Linear GraphQL Explorer

Go to https://linear.app/developers and open the API explorer. Run these queries:

#### Find your Team ID

```graphql
query {
  teams {
    nodes {
      id
      name
      key
    }
  }
}
```

Look for your team's `key` (e.g., "ENG") and note the `id` (a UUID like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

#### Find Workflow State IDs

```graphql
query TeamStates($teamId: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } } }) {
    nodes {
      id
      name
      type
    }
  }
}
```

Variables:
```json
{
  "teamId": "your-team-uuid-here"
}
```

You need the UUIDs for these states:
- **Ready** (or "Todo") -- the state issues must be in to be picked up by the executor
- **Done** -- the state the executor moves issues to on success
- **Blocked** (or "Backlog") -- the state the executor moves issues to on failure/timeout

### Option B: cURL

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: lin_api_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ teams { nodes { id name key } } }"}' | jq .
```

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: lin_api_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ workflowStates(filter: { team: { id: { eq: \"YOUR_TEAM_UUID\" } } }) { nodes { id name type } } }"}' | jq .
```

---

## Configuring the Workflows

Each workflow has a **"Set Config"** Code node at the beginning. Open it and fill in your values.

### Executor Workflow -- Set Config

| Field | Description | Example |
|---|---|---|
| `linearApiKey` | Your Linear API key | `lin_api_abc123...` |
| `teamId` | Linear team UUID | `a1b2c3d4-...` |
| `readyStateId` | UUID of "Ready"/"Todo" state | `e5f6g7h8-...` |
| `blockedStateId` | UUID of "Blocked" state | `i9j0k1l2-...` |
| `doneStateId` | UUID of "Done" state | `m3n4o5p6-...` |
| `projectPath` | Absolute path to target project | `/home/user/my-project` |
| `projectName` | Human-readable project name | `my-project` |
| `techStack` | Tech stack description | `TypeScript, Next.js, Prisma` |
| `testCommand` | Command to run tests | `npm test` |
| `lintCommand` | Command to run linting | `npm run lint` |
| `maxParallel` | Max issues per run | `3` |
| `timeoutSeconds` | Per-issue timeout | `1800` (30 min) |
| `autopilotPath` | Path to claude-autopilot repo | `/home/user/claude-autopilot` |

### Auditor Workflow -- Set Config

| Field | Description | Example |
|---|---|---|
| `linearApiKey` | Your Linear API key | `lin_api_abc123...` |
| `teamId` | Linear team UUID | `a1b2c3d4-...` |
| `readyStateId` | UUID of "Ready"/"Todo" state | `e5f6g7h8-...` |
| `projectPath` | Absolute path to target project | `/home/user/my-project` |
| `autopilotPath` | Path to claude-autopilot repo | `/home/user/claude-autopilot` |
| `minReadyThreshold` | Skip audit if Ready count >= this | `5` |
| `timeoutSeconds` | Auditor timeout | `3600` (60 min) |

---

## How Parallel Execution Works

### Executor fan-out

The executor workflow uses n8n's native item-based parallelism:

1. The **Filter Unblocked** Code node returns multiple items (one per issue, up to `maxParallel`).
2. The **Has Issues?** IF node passes all items to the true branch.
3. The **Claude Code** Execute Command node runs once per item automatically. n8n processes each item through the node, and with `continueOnFail: true`, a failure on one issue does not stop the others.
4. The **Summarize Results** node collects all outcomes.

By default, n8n executes items sequentially within a single workflow execution. To enable true parallel execution:

- **Option 1 (recommended)**: Set `maxParallel` to 1 and let the Schedule Trigger's 10-minute interval handle throughput. Multiple workflow executions can run in parallel if you enable **Settings > Workflow > Execute in parallel** in n8n.
- **Option 2**: Use a **Split In Batches** node before the Execute Command node to process N items at a time. Insert it between the IF node and the Claude Code node, set batch size to your desired parallelism.
- **Option 3**: In n8n's workflow settings, enable **"Execute Workflow in Parallel"** so overlapping schedule triggers each run their own execution.

### Auditor

The auditor runs a single long-running process (up to 60 minutes). It does not fan out -- it runs one Claude Code session that handles the entire audit internally.

---

## Monitoring and Debugging

### Execution history

n8n keeps a log of every workflow execution. Go to **Executions** in the left sidebar to see:
- When each run started and finished
- Which branch (true/false) was taken at the IF node
- The full output of every node, including Claude Code stdout/stderr
- Any errors that occurred

### Common issues

**"Command not found: claude"**
The n8n process cannot find the Claude CLI. Ensure the `claude` binary is in the PATH visible to n8n. If running n8n via systemd or Docker, you may need to set the PATH explicitly. For Docker, mount the host's Claude CLI into the container or install it inside the container.

**"Command not found: bun"**
Same issue as above. Ensure `bun` is in the PATH visible to n8n.

**"LINEAR_API_KEY environment variable is not set"**
The `bun run auditor` command expects `LINEAR_API_KEY` in the environment. Either:
- Set it in the n8n environment (Settings > Environment Variables in self-hosted)
- Export it in the shell profile of the user running n8n
- Add it to the Execute Command's environment (prefix the command with `export LINEAR_API_KEY=... &&`)

Note: The executor workflow passes the Linear API key directly via HTTP headers in the GraphQL request, so it does not need the environment variable. However, the Claude Code process spawned by the executor will need it if the executor prompt uses Linear MCP tools. Set it in the host environment.

**Timeouts**
If Claude Code consistently times out:
- Increase `timeoutSeconds` in the Set Config node
- Check if the issues being picked up are too large/complex
- Look at the partial output in the execution log to see where it stalled

**Empty results from Linear**
If Query Linear returns no issues:
- Verify your `teamId` and `readyStateId` UUIDs are correct
- Check that issues actually exist in the Ready state in Linear
- Test the GraphQL query manually using cURL (see "Finding Your Linear UUIDs" above)

### Logging

Both workflows log to stdout within their Code and Execute Command nodes. All output is captured in n8n's execution log. For persistent logging, consider adding an n8n node that writes to a file or sends to a logging service after the Summarize nodes.

---

## Cost Expectations

### Claude Max subscription

With a Claude Max subscription, you get unlimited Claude Code usage but with concurrency limits:

- **Safe parallelism**: 3-5 concurrent Claude Code sessions
- Set `maxParallel` to 3 in the executor config
- The auditor uses 1 session, so total peak concurrency is 4 (3 executor + 1 auditor)
- If you hit rate limits, reduce `maxParallel` or stagger the executor and auditor schedules

### Claude API (pay-per-token)

With the Anthropic API:

- **Higher parallelism**: 10+ concurrent sessions are feasible depending on your rate tier
- **Cost**: Varies by model and token usage. A typical executor run (reading issue, planning, implementing, testing, committing) uses roughly 50k-200k tokens per issue
- **Estimate**: At Claude Sonnet pricing, expect approximately $0.50-$2.00 per issue for straightforward tasks, more for complex ones
- **Auditor runs**: The auditor scans the full codebase and can use 200k-500k tokens per run
- Monitor your usage at https://console.anthropic.com/

### Controlling costs

- Start with `maxParallel: 1` and increase gradually
- Set conservative timeouts to prevent runaway sessions
- Use the auditor's `minReadyThreshold` to avoid unnecessary audit runs
- Review the execution history regularly to catch issues that consistently fail (wasting tokens on retries)

---

## Quick Start Checklist

1. [ ] n8n self-hosted instance running
2. [ ] Claude CLI installed and authenticated on the host
3. [ ] Bun installed on the host
4. [ ] `claude-autopilot` repo cloned and `bun install` completed
5. [ ] `LINEAR_API_KEY` exported in the host environment
6. [ ] Linear team UUID obtained
7. [ ] Linear workflow state UUIDs obtained (Ready, Done, Blocked)
8. [ ] Executor workflow imported and Set Config filled in
9. [ ] Auditor workflow imported and Set Config filled in
10. [ ] Both workflows activated in n8n
11. [ ] Test: manually trigger executor workflow, verify it queries Linear correctly
12. [ ] Test: manually trigger auditor workflow, verify threshold check works
