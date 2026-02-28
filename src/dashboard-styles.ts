export const DASHBOARD_CSS = `
  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  :root {
    --bg: #0d1117;
    --bg-surface: #161b22;
    --bg-card: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
  }
  body {
    font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    font-size: 13px;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  header h1 {
    font-size: 14px;
    font-weight: 600;
  }
  header .meta {
    color: var(--text-dim);
    font-size: 12px;
  }
  .layout {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  .sidebar {
    width: 320px;
    min-width: 320px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    background: var(--bg-surface);
  }
  .main {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }
  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    padding: 12px 16px 6px;
  }
  .agent-card {
    display: block;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    text-decoration: none;
    color: inherit;
  }
  .agent-card:hover {
    background: var(--bg-card);
  }
  .agent-card.selected {
    background: var(--bg-card);
    border-left: 2px solid var(--accent);
    padding-left: 14px;
  }
  .agent-card .issue-id {
    color: var(--accent);
    font-weight: 600;
    font-size: 12px;
  }
  .agent-card .title {
    font-size: 12px;
    color: var(--text);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-card .meta {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 3px;
  }
  .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 4px;
  }
  .status-dot.running {
    background: var(--green);
    animation: pulse 2s infinite;
  }
  .status-dot.completed {
    background: var(--green);
  }
  .status-dot.failed {
    background: var(--red);
  }
  .status-dot.timed_out {
    background: var(--yellow);
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  .activity-item {
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .activity-item .time {
    color: var(--text-dim);
    font-size: 11px;
  }
  .activity-item .type-badge {
    display: inline-block;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    margin: 0 4px;
  }
  .type-badge.tool_use {
    background: #1f3a5f;
    color: var(--accent);
  }
  .type-badge.text {
    background: #2a1f3f;
    color: var(--purple);
  }
  .type-badge.result {
    background: #1a3a1a;
    color: var(--green);
  }
  .type-badge.error {
    background: #3f1f1f;
    color: var(--red);
  }
  .type-badge.status {
    background: #3a2f1a;
    color: var(--yellow);
  }
  .type-badge.subagent {
    background: #1a2a2a;
    color: #5a8a8a;
    font-size: 9px;
  }
  .activity-item.subagent {
    opacity: 0.6;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-dim);
  }
  .empty-state .icon {
    font-size: 32px;
    margin-bottom: 12px;
  }
  .stats-bar {
    display: flex;
    gap: 20px;
    margin-left: auto;
  }
  .stat {
    text-align: center;
  }
  .stat .value {
    font-weight: 600;
    font-size: 16px;
  }
  .stat .label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .detail-text {
    margin-top: 4px;
    padding: 8px 10px;
    background: var(--bg);
    border-left: 2px solid var(--border);
    border-radius: 0 4px 4px 0;
    font-size: 11px;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .history-card {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .history-card .issue-id {
    font-weight: 600;
    font-size: 11px;
  }
  .history-card .title {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .triage-card {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .triage-card .issue-id {
    font-weight: 600;
    font-size: 11px;
    color: var(--accent);
  }
  .triage-card .title {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .triage-card .triage-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .action-btn.approve {
    border-color: var(--green);
    color: var(--green);
  }
  .action-btn.approve:hover {
    background: #1a3a1a;
  }
  .pause-btn {
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .pause-btn:hover {
    background: var(--border);
  }
  .pause-btn.paused {
    background: var(--yellow);
    color: var(--bg);
    border-color: var(--yellow);
  }
  .action-btn {
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid var(--border);
    background: var(--bg-card);
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .action-btn:hover {
    background: var(--border);
  }
  .action-btn.disabled {
    opacity: 0.5;
    cursor: default;
  }
  .action-btn.danger {
    border-color: var(--red);
    color: var(--red);
  }
  .action-btn.danger:hover {
    background: #3f1f1f;
  }
  .planning-badge {
    display: inline-block;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    background: #2a1f3f;
    color: var(--purple);
    margin-left: 8px;
  }
  .activity-status {
    padding: 10px 0;
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .activity-status .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    animation: pulse 2s infinite;
  }
  .budget-bar {
    font-size: 12px;
    color: var(--text-dim);
    padding: 0 4px;
  }
  .cost-trends-bar {
    font-size: 11px;
    color: var(--text-dim);
  }
  .cost-trends-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cost-trend-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cost-trend-date {
    width: 30px;
  }
  .cost-trend-bar-track {
    width: 60px;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .cost-trend-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }
  .cost-trend-amount {
    width: 38px;
    text-align: right;
  }
  .cost-trends-summary {
    color: var(--text-dim);
    margin-top: 2px;
  }
  .failure-analysis-bar {
    font-size: 11px;
    color: var(--text-dim);
  }
  .failure-analysis-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .repeat-failure-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 2px 0;
  }
  .repeat-failure-count {
    color: var(--red);
    font-weight: 600;
    min-width: 20px;
  }
  .repeat-failure-error {
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  .planning-card {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    cursor: pointer;
  }
  .planning-card:hover {
    background: var(--bg-card);
  }
  .planning-card.selected {
    background: var(--bg-card);
    border-left: 2px solid var(--purple);
    padding-left: 14px;
  }
  .planning-card .summary {
    color: var(--text-dim);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }
  .planning-detail {
    padding: 0;
  }
  .planning-findings {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .planning-findings li {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .planning-findings li .reason {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
  }
  .planning-issues-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .planning-issues-list li {
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }
  .planning-issues-list li .issue-id {
    color: var(--accent);
    font-weight: 600;
    font-size: 11px;
  }
  .cost-section {
    padding: 8px 16px;
  }
  .cost-subtitle {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    margin: 12px 0 6px;
    letter-spacing: 0.5px;
  }
  .cost-day-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 12px;
  }
  .cost-date {
    width: 40px;
    color: var(--text-dim);
  }
  .cost-bar-bg {
    flex: 1;
    height: 8px;
    background: var(--bg);
    border-radius: 4px;
    overflow: hidden;
  }
  .cost-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 4px;
    transition: width 0.3s;
  }
  .cost-amount {
    width: 60px;
    text-align: right;
    color: var(--green);
  }
  .cost-runs {
    width: 30px;
    text-align: right;
    color: var(--text-dim);
    font-size: 11px;
  }
  .cost-issue-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 12px;
  }
  .cost-issue-row .issue-id {
    flex: 1;
  }
`;
