// ---------------------------------------------------------------------------
// Standardized MCP response envelopes
// ---------------------------------------------------------------------------

/**
 * Successful tool result. Always returns { ok: true, data: ... } so agents
 * can reliably pattern-match on `ok` without parsing arbitrary shapes.
 */
export function mcpOk(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }, null, 2) }],
  };
}

/**
 * Error tool result. Returns { ok: false, error: { code, message, retryable } }
 * so agents can programmatically decide whether to retry.
 *
 * @param code      Machine-readable error code (e.g. "RATE_LIMIT", "NOT_FOUND")
 * @param message   Human-readable description
 * @param retryable Whether the agent should retry the same call after a delay
 */
export function mcpError(code: string, message: string, retryable = false) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: false, error: { code, message, retryable } }),
    }],
    isError: true as const,
  };
}

/** Convenience: wrap a caught Error/unknown into a structured mcpError. */
export function mcpCaughtError(err: unknown, code = "INTERNAL_ERROR") {
  const message = err instanceof Error ? err.message : String(err);
  return mcpError(code, message, false);
}
