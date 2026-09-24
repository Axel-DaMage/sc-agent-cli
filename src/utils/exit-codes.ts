// Documented exit-code contract for headless/batch mode (#409).
// Stable across releases — wrappers must be able to branch on $? alone.
//
//   0  success (with or without changes before #412; =with-changes after)
//   1  generic/unspecified error
//   10 success, zero mutations        (SCC_NO_CHANGES,      #412)
//   20 provider error                 (network, timeout, 5xx, empty responses)
//   21 auth error                     (401/403, invalid or missing API key)
//   22 budget exhausted               (SC_BUDGET_EXCEEDED,  #408)
//   23 agent-loop abort               (tool livelock, malformed-args storm)
//
// Reserved ranges: 2-9 other clean terminals, 11-19 run outcomes, 24+ fatal.

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  NO_CHANGES: 10,
  PROVIDER_ERROR: 20,
  AUTH_ERROR: 21,
  BUDGET_EXCEEDED: 22,
  LOOP_ABORT: 23,
} as const;

// Map an error (message) to a documented exit code. Order matters: auth
// patterns are checked before generic provider errors since both can
// appear in the same message.
export function classifyError(err: unknown): number {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.{0,12}api.?key|api.?key.{0,12}(invalid|missing|required)|requires?.{0,15}api.?key|authentication/.test(msg)) {
    return EXIT_CODES.AUTH_ERROR;
  }
  if (/\[sc_livelock\]|tool livelock/.test(msg)) {
    return EXIT_CODES.LOOP_ABORT;
  }
  if (/empty response|fetch|network|timeout|timed out|econnrefused|econnreset|enotfound|socket hang|api_error|\b5\d\d\b|rate.?limit/.test(msg)) {
    return EXIT_CODES.PROVIDER_ERROR;
  }
  return EXIT_CODES.ERROR;
}
