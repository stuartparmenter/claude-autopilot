/** Redact sensitive tokens from error messages and transcripts before logging or storing. */
export function sanitizeMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[^\s"\\]+/g, "Bearer [REDACTED]")
    .replace(/lin_api_[^\s"\\]+/g, "lin_api_[REDACTED]")
    .replace(/sk-ant-[^\s"\\]+/g, "sk-ant-[REDACTED]")
    .replace(/ghp_[^\s"\\]+/g, "ghp_[REDACTED]")
    .replace(/gho_[^\s"\\]+/g, "gho_[REDACTED]")
    .replace(/ghs_[^\s"\\]+/g, "ghs_[REDACTED]")
    .replace(/ghu_[^\s"\\]+/g, "ghu_[REDACTED]")
    .replace(/github_pat_[^\s"\\]+/g, "github_pat_[REDACTED]")
    .replace(/AKIA[A-Z0-9]{16}/g, "AKIA[REDACTED]")
    .replace(/(password|secret|api_key|token)=[^\s"\\]+/gi, "$1=[REDACTED]")
    .replace(
      /hooks\.slack\.com\/services\/[^\s"\\]+/g,
      "hooks.slack.com/services/[REDACTED]",
    )
    .replace(/npm_[A-Za-z0-9]{36}/g, "npm_[REDACTED]")
    .replace(
      /(sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|rk_test_)[^\s"\\]+/g,
      "$1[REDACTED]",
    );
}
