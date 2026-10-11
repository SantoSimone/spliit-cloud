import { Effect, Tracer } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  annotateTokenUsage,
  createRequestTracing,
  describeErrorValue,
  printTrace,
  withTraceSpan,
  type FinishedSpan,
} from './spans'

function runTraced<A, E>(
  tracing: { tracer: Tracer.Tracer },
  effect: Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(Tracer.Tracer, tracing.tracer)),
  )
}

describe('createRequestTracing', () => {
  it('records nested spans with attributes and durations', async () => {
    const tracing = createRequestTracing()
    await runTraced(
      tracing,
      Effect.gen(function* () {
        yield* Effect.sleep(5)
        yield* Effect.annotateCurrentSpan('scan.extraction', 'ocr')
        yield* Effect.succeed('step').pipe(
          withTraceSpan('scan.ocr', { 'scan.ocr.provider': 'ocrspace' }),
        )
      }).pipe(withTraceSpan('scan.receipt')),
    )

    const names = tracing.spans.map((span) => span.name)
    expect(names).toContain('scan.receipt')
    expect(names).toContain('scan.ocr')
    const root = tracing.spans.find((span) => span.name === 'scan.receipt')
    const child = tracing.spans.find((span) => span.name === 'scan.ocr')
    expect(root?.attributes['scan.extraction']).toBe('ocr')
    expect(child?.attributes['scan.ocr.provider']).toBe('ocrspace')
    expect(child?.parentId).toBe(root?.id)
    expect(root && root.durationMs).toBeGreaterThan(0)
    expect(child?.error).toBeNull()
  })

  it('records a failure cue when a step fails', async () => {
    const tracing = createRequestTracing()
    await expect(
      runTraced(
        tracing,
        Effect.fail(new Error('OCR down')).pipe(withTraceSpan('scan.ocr')),
      ),
    ).rejects.toThrow('OCR down')

    expect(tracing.spans).toHaveLength(1)
    expect(tracing.spans[0]?.error).toContain('OCR down')
  })

  it('stays a no-op without a provided tracer', async () => {
    await expect(
      Effect.runPromise(Effect.succeed(1).pipe(withTraceSpan('scan.ocr'))),
    ).resolves.toBe(1)
    await expect(
      Effect.runPromise(annotateTokenUsage({ inputTokens: 3 })),
    ).resolves.toBeUndefined()
  })

  it('records token usage on the current step span', async () => {
    const tracing = createRequestTracing()
    await runTraced(
      tracing,
      Effect.gen(function* () {
        yield* annotateTokenUsage({ inputTokens: 1204, outputTokens: 310 })
      }).pipe(withTraceSpan('scan.structure')),
    )

    expect(
      tracing.spans.find((span) => span.name === 'scan.structure')?.attributes,
    ).toMatchObject({
      'llm.usage.input_tokens': 1204,
      'llm.usage.output_tokens': 310,
    })
  })

  it('skips token annotation when the SDK result carries no usage', async () => {
    const tracing = createRequestTracing()
    await runTraced(
      tracing,
      Effect.gen(function* () {
        yield* annotateTokenUsage(undefined)
      }).pipe(withTraceSpan('scan.structure')),
    )

    expect(
      tracing.spans.find((span) => span.name === 'scan.structure')?.attributes,
    ).toEqual({})
  })
})

describe('printTrace', () => {
  const spans: Array<FinishedSpan> = [
    {
      id: 'root',
      parentId: null,
      name: 'scan.receipt',
      startMs: 0,
      durationMs: 12400,
      attributes: { 'scan.extraction': 'ocr' },
      error: null,
    },
    {
      id: 'ocr',
      parentId: 'root',
      name: 'scan.ocr',
      startMs: 600,
      durationMs: 8100,
      attributes: { 'scan.ocr.provider': 'ocrspace', 'scan.ocr.chars': 2140 },
      error: null,
    },
    {
      id: 'structure',
      parentId: 'root',
      name: 'scan.structure',
      startMs: 8800,
      durationMs: 3200,
      attributes: {
        'llm.model': 'gpt-5-nano',
        'llm.usage.input_tokens': 1204,
      },
      error: null,
    },
  ]

  it('renders a human-readable timing tree with a route header', () => {
    const lines: Array<string> = []
    printTrace(
      spans,
      { label: 'scan', route: 'ocr+separate(system-one)' },
      (line) => lines.push(line),
    )

    expect(lines[0]).toBe('[scan] 12.4s route=ocr+separate(system-one)')
    expect(lines).toContain('└─ scan.receipt 12.4s extraction=ocr')
    expect(lines).toContain('   ├─ scan.ocr 8.1s chars=2140 provider=ocrspace')
    expect(lines).toContain(
      '   └─ scan.structure 3.2s model=gpt-5-nano input_tokens=1204',
    )
  })

  it('marks failed spans with the error cue', () => {
    const lines: Array<string> = []
    printTrace(
      [
        {
          id: 'root',
          parentId: null,
          name: 'scan.receipt',
          startMs: 0,
          durationMs: 30_000,
          attributes: {},
          error: 'TimeoutError',
        },
      ],
      { label: 'scan' },
      (line) => lines.push(line),
    )

    expect(lines).toContain('└─ scan.receipt 30.0s ✗ TimeoutError')
  })

  it('prints just the header when no spans were collected', () => {
    const lines: Array<string> = []
    printTrace([], { label: 'voice' }, (line) => lines.push(line))

    expect(lines).toEqual(['[voice] 0ms'])
  })
})

describe('describeErrorValue', () => {
  it('renders errors, tagged values, and strings compactly', () => {
    expect(describeErrorValue(new Error('OCR down'))).toBe('Error: OCR down')
    expect(describeErrorValue({ _tag: 'TimeoutError' })).toBe('TimeoutError')
    expect(describeErrorValue('plain reason')).toBe('plain reason')
    expect(describeErrorValue({ status: 429 })).toBe('{"status":429}')
  })
})
