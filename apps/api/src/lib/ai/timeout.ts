/**
 * Shared helpers for bounding AI provider calls.
 *
 * The Vercel AI SDK aborts `generateText` with a `DOMException` named
 * `TimeoutError` when its `timeout` elapses (see `set-abort-timeout` in the
 * `ai` package). There is no exported error class to `instanceof` against, so
 * callers duck-type on `name`/`message` — the same pattern used by
 * `currency-rates.ts` and the CSV importer.
 */

/** True when `error` looks like an AI SDK / fetch timeout or abort. */
export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  // Effect v4 `Effect.timeout` fails with a `Cause.TimeoutError` carrying
  // `_tag: "TimeoutError"` (see `ai-effects/ai.ts`). It reaches procedure
  // boundaries unwrapped via `Effect.runPromise`, so match it structurally
  // rather than importing Effect here and coupling this helper to it.
  if ('_tag' in error && error._tag === 'TimeoutError') return true
  const name = 'name' in error ? String(error.name) : ''
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const message = 'message' in error ? String(error.message) : ''
  if (/timed? ?out/i.test(message)) return true
  const cause = 'cause' in error ? error.cause : undefined
  return cause !== undefined && isTimeoutError(cause)
}

/**
 * Convert a `*_TIMEOUT_SECONDS` env value to the milliseconds `generateText`
 * expects.
 */
export function timeoutSecondsToMs(seconds: number): number {
  return seconds * 1000
}
