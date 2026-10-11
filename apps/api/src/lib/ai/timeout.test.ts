import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { liftAiCall, withAiBudget } from '../ai-effects/ai'
import { isTimeoutError, timeoutSecondsToMs } from './timeout'

describe('isTimeoutError', () => {
  it('matches AI SDK timeout aborts', () => {
    expect(
      isTimeoutError(
        new DOMException('total timeout of 120000ms exceeded', 'TimeoutError'),
      ),
    ).toBe(true)
  })

  it('matches aborts and timeout messages without a structured code', () => {
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true)
    expect(isTimeoutError(new Error('Request timed out'))).toBe(true)
    expect(isTimeoutError({ name: 'TimeoutError', message: 'upsteam' })).toBe(
      true,
    )
  })

  it('matches real Effect v4 timeout failures end to end', async () => {
    // Guards the `ai-effects/ai.ts` budget story: a hung effect must surface
    // as a `_tag: "TimeoutError"` failure that `isTimeoutError` recognizes,
    // so the procedure maps it to TIMEOUT instead of hanging the scan.
    const budgeted = await Effect.runPromise(
      Effect.flip(withAiBudget(Effect.never, 0.01)),
    )
    expect(budgeted._tag).toBe('TimeoutError')
    expect(isTimeoutError(budgeted)).toBe(true)

    const hungCall = await Effect.runPromise(
      Effect.flip(
        liftAiCall(() => new Promise<never>(() => {}), {
          timeoutSeconds: 0.01,
        }),
      ),
    )
    expect(isTimeoutError(hungCall)).toBe(true)
  })

  it('follows nested causes', () => {
    expect(
      isTimeoutError({
        message: 'fetch failed',
        cause: { name: 'TimeoutError' },
      }),
    ).toBe(true)
  })

  it('rejects unrelated failures', () => {
    expect(isTimeoutError(new Error('AI service unavailable'))).toBe(false)
    expect(isTimeoutError({ code: 'TIMEOUT' })).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
    expect(isTimeoutError(undefined)).toBe(false)
    expect(isTimeoutError('timeout')).toBe(false)
  })

  it('passes provider rejections through unwrapped (no UnknownError)', async () => {
    // Regression for the production INTERNAL_SERVER_ERROR "An error occurred
    // in Effect.tryPromise": the single-arg tryPromise form wrapped every
    // generateText rejection in UnknownError, degrading the tRPC message and
    // breaking the procedure's duck-typed mapping. The original error must
    // reach the tRPC boundary with its identity and message intact.
    const original = new Error('AI service unavailable')
    const failure = await Effect.runPromise(
      Effect.flip(
        liftAiCall(() => Promise.reject(original), { timeoutSeconds: 30 }),
      ),
    )
    expect(failure).toBe(original)
    expect(isTimeoutError(failure)).toBe(false)
  })
})

describe('timeoutSecondsToMs', () => {
  it('converts seconds env values to generateText milliseconds', () => {
    expect(timeoutSecondsToMs(120)).toBe(120_000)
    expect(timeoutSecondsToMs(30)).toBe(30_000)
  })
})
