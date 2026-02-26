import type {
  SDKAssistantMessage,
  SDKResultError,
} from "@anthropic-ai/claude-agent-sdk";
import type { ActivityEntry } from "../state";

/** Maps tool names to the input field used in their activity summary. */
export const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
};

export function summarizeToolUse(
  toolName: string,
  input: unknown,
  cwd?: string,
): string {
  const inp =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  const field = TOOL_SUMMARY_FIELDS[toolName];
  if (field) {
    let value = String(inp[field] ?? "");
    if (cwd && value.startsWith(cwd)) {
      value = value.slice(cwd.length).replace(/^\//, "");
    }
    return `${toolName}: ${value}`;
  }
  if (toolName === "Task") {
    return `Task: ${inp.description ?? inp.subagent_type ?? "subagent"}`;
  }
  return `Tool: ${toolName}`;
}

export interface AgentMessageResult {
  activities: ActivityEntry[];
  /** Set when a system/init message is received. */
  sessionId?: string;
  /** Set when a result/success message is received. */
  successResult?: {
    result: string;
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
  };
  /** Set when a result/error message is received. */
  errorMessage?: string;
}

/**
 * Map a single SDK agent message to activity entries and structured result data.
 * Pure function — no side effects, suitable for independent testing and multiple consumers.
 */
export function processAgentMessage(
  message: unknown,
  cwd?: string,
): AgentMessageResult {
  const activities: ActivityEntry[] = [];
  const msg = message as {
    type: string;
    subtype?: string;
    [key: string]: unknown;
  };

  if (msg.type === "system" && msg.subtype === "init") {
    activities.push({
      timestamp: Date.now(),
      type: "status",
      summary: "Agent started",
    });
    return { activities, sessionId: msg.session_id as string | undefined };
  }

  if (msg.type === "assistant" && msg.message) {
    const { content } = (message as SDKAssistantMessage).message;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use" && "name" in block) {
          activities.push({
            timestamp: Date.now(),
            type: "tool_use",
            summary: summarizeToolUse(block.name, block.input, cwd),
          });
        } else if (block.type === "text" && "text" in block) {
          activities.push({
            timestamp: Date.now(),
            type: "text",
            summary: block.text.slice(0, 200),
            detail: block.text,
          });
        }
      }
    }
    return { activities };
  }

  if (msg.type === "result") {
    if (msg.subtype === "success") {
      activities.push({
        timestamp: Date.now(),
        type: "result",
        summary: "Agent completed successfully",
      });
      return {
        activities,
        successResult: {
          result: msg.result as string,
          costUsd: msg.total_cost_usd as number | undefined,
          durationMs: msg.duration_ms as number | undefined,
          numTurns: msg.num_turns as number | undefined,
        },
      };
    } else {
      const errResult = message as SDKResultError;
      const errorMessage = errResult.errors?.length
        ? errResult.errors.join("; ")
        : errResult.subtype;
      activities.push({
        timestamp: Date.now(),
        type: "error",
        summary: `Agent error: ${errorMessage.slice(0, 200)}`,
      });
      return { activities, errorMessage };
    }
  }

  return { activities };
}

/** Create an error ActivityEntry with the current timestamp. */
export function makeErrorActivity(summary: string): ActivityEntry {
  return { timestamp: Date.now(), type: "error", summary };
}
