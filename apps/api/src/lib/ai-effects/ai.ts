import { Duration, Effect, type Cause } from 'effect'

import { timeoutSecondsToMs } from '../ai/timeout'

/**
 * Shared helpers for lifting AI SDK promise calls into Effect.
 *
 * The Vercel AI SDK enforces its own `timeout` via abort, and every call site
 * keeps passing it (defense in depth, and existing tests assert the budget).
 * The Effect side adds a typed `Cause.TimeoutError` failure (recognized by the
 * extended `isTimeoutError`) so a hung SDK still surfaces as a stage timeout at
 * the tRPC boundary instead of hanging the procedure.
 *
 * Provider errors pass through unmapped: procedures predate Effect and map them
 * with the long-standing duck-typed checks. Only genuinely new failure modes
 * get new tags (see `./errors`).
 */

/** Run an AI SDK effect with an Effect-side time budget. */
export function withAiBudget<A, E>(
  effect: Effect.Effect<A, E>,
  timeoutSeconds: number,
): Effect.Effect<A, E | Cause.TimeoutError> {
  return effect.pipe(
    Effect.timeout(Duration.millis(timeoutSecondsToMs(timeoutSeconds))),
  )
}

/**
 * Lift a promise-returning AI call into Effect, bounding it with
 * `timeoutSeconds`. Rejections pass through unmapped (see `./errors`).
 */
export function liftAiCall<A>(
  run: () => Promise<A>,
  options: { timeoutSeconds: number },
): Effect.Effect<A, unknown> {
  const lifted: Effect.Effect<A, unknown> = Effect.tryPromise({
    try: run,
    // Pass rejections through unwrapped. The single-arg `tryPromise(run)`
    // form wraps every rejection in `UnknownError("An error occurred in
    // Effect.tryPromise")`, which degrades the tRPC INTERNAL_SERVER_ERROR
    // message and breaks the procedures' duck-typed error mapping that
    // predates Effect. Only genuinely new failure modes get new tags.
    catch: (cause) => cause,
  })
  return withAiBudget(lifted, options.timeoutSeconds)
}
