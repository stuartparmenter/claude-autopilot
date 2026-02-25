/** Redact sensitive tokens from error messages before logging or posting externally. */
export function sanitizeMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/g, "Bearer [REDACTED]")
    .replace(/lin_api_\S+/g, "lin_api_[REDACTED]")
    .replace(/sk-ant-\S+/g, "sk-ant-[REDACTED]")
    .replace(/ghp_\S+/g, "ghp_[REDACTED]")
    .replace(/gho_\S+/g, "gho_[REDACTED]")
    .replace(/ghs_\S+/g, "ghs_[REDACTED]")
    .replace(/ghu_\S+/g, "ghu_[REDACTED]")
    .replace(/github_pat_\S+/g, "github_pat_[REDACTED]");
}
