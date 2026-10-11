import { Cause, Effect, Option, Tracer, type Exit } from 'effect'

/**
 * Request-scoped Effect tracing with a console exporter.
 *
 * Spans are the async equivalent of a callstack: each records a name, timing,
 * attributes, and a parent, forming one tree per request. They are inert by
 * default (Effect runs `withSpan` bodies as no-ops without a provided tracer),
 * so annotating code costs nothing until a caller provides the tracer from
 * `createRequestTracing()` and prints the result.
 *
 * This module is intentionally generic and app-wide: any flow (receipt scan,
 * voice extraction, categorization, …) wraps its steps in `withTraceSpan`,
 * provides one collector per request, and prints a human-readable timing tree
 * when the `TRACING_ENABLED` operator flag is on. A future OTLP exporter only
 * needs to swap the sink — span names already use OTEL-style dotted keys.
 *
 * Attribute rule: counts, model ids, and routing labels only. Never log receipt
 * text, titles, transcripts, or anything user-identifying here.
 */

/** One finished span: timing, routing metadata, and failure cue. */
export type FinishedSpan = {
  id: string
  parentId: string | null
  name: string
  /** Wall-clock start in milliseconds (monotonic clock, for ordering). */
  startMs: number
  durationMs: number
  attributes: Record<string, unknown>
  /** Human-readable failure cue, or null when the span succeeded. */
  error: string | null
}

function describeSpanError(exit: Exit.Exit<unknown, unknown>): string | null {
  if (exit._tag === 'Success') return null
  const failure = Cause.findErrorOption(exit.cause)
  const value: unknown = Option.isSome(failure) ? failure.value : exit.cause
  return describeErrorValue(value)
}

/**
 * One-line human-readable cue for a step failure (provider errors, timeouts).
 * Truncated and free of payload data — safe for trace attributes.
 */
export function describeErrorValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`.slice(0, 160)
  }
  if (typeof value === 'string') return value.slice(0, 160)
  if (typeof value === 'object' && value !== null && '_tag' in value) {
    const tag = (value as { _tag: unknown })._tag
    if (typeof tag === 'string') return tag
  }
  try {
    return (JSON.stringify(value) ?? 'unknown failure').slice(0, 160)
  } catch {
    return 'unknown failure'
  }
}

type SpanRecorder = (
  span: Tracer.NativeSpan,
  exit: Exit.Exit<unknown, unknown>,
) => void

/**
 * Native span that reports itself to the per-request collector on completion.
 * Ids, attributes, and status bookkeeping stay with the battle-tested
 * implementation; only the finished-span handoff is custom.
 */
class RecordingSpan extends Tracer.NativeSpan {
  constructor(
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0],
    private readonly record: SpanRecorder,
  ) {
    super(options)
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    this.record(this, exit)
  }
}

function toFinishedSpan(
  span: Tracer.NativeSpan,
  exit: Exit.Exit<unknown, unknown>,
): FinishedSpan {
  const status = span.status
  const startNs = status._tag === 'Ended' ? status.startTime : 0n
  return {
    id: span.spanId,
    parentId: Option.getOrNull(Option.map(span.parent, (p) => p.spanId)),
    name: span.name,
    startMs: Number(startNs) / 1_000_000,
    durationMs:
      status._tag === 'Ended'
        ? Number(status.endTime - status.startTime) / 1_000_000
        : 0,
    attributes: Object.fromEntries(span.attributes),
    error: describeSpanError(exit),
  }
}

export type TraceHeader = {
  /** Short flow label, e.g. `scan` or `voice`. */
  label: string
  /** Combined routing summary, e.g. `ocr+separate(system-one)`. */
  route?: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatAttributeValue(value: unknown): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').slice(0, 80)
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' || typeof value === 'function') {
    try {
      return (JSON.stringify(value) ?? 'unknown').slice(0, 80)
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

/** Last dotted segment (`scan.fetch.bytes` → `bytes`) for compact lines. */
function shortAttributeKey(key: string): string {
  const dot = key.lastIndexOf('.')
  return dot >= 0 ? key.slice(dot + 1) : key
}

function renderSpan(
  span: FinishedSpan,
  children: ReadonlyMap<string, Array<FinishedSpan>>,
  prefix: string,
  isLast: boolean,
  write: (line: string) => void,
): void {
  const attributes = Object.keys(span.attributes)
    .sort()
    .map(
      (key) =>
        `${shortAttributeKey(key)}=${formatAttributeValue(span.attributes[key])}`,
    )
    .join(' ')
  write(
    `${prefix}${isLast ? '└─ ' : '├─ '}${span.name} ${formatDuration(span.durationMs)}` +
      (attributes ? ` ${attributes}` : '') +
      (span.error ? ` ✗ ${span.error}` : ''),
  )
  const kids = children.get(span.id) ?? []
  const childPrefix = prefix + (isLast ? '   ' : '│  ')
  kids.forEach((child, index) => {
    renderSpan(child, children, childPrefix, index === kids.length - 1, write)
  })
}

/**
 * Print one human-readable timing tree for the collected spans. Pure over the
 * span list (console is just the default sink) so tests assert on strings.
 */
export function printTrace(
  spans: ReadonlyArray<FinishedSpan>,
  header: TraceHeader,
  write: (line: string) => void = console.log,
): void {
  const ids = new Set(spans.map((span) => span.id))
  const roots = spans.filter(
    (span) => span.parentId === null || !ids.has(span.parentId),
  )
  if (roots.length === 0) {
    write(
      `[${header.label}] 0ms${header.route ? ` route=${header.route}` : ''}`,
    )
    return
  }
  const ends = spans.map((span) => span.startMs + span.durationMs)
  const totalMs = Math.max(...ends) - Math.min(...spans.map((s) => s.startMs))
  write(
    `[${header.label}] ${formatDuration(totalMs)}${header.route ? ` route=${header.route}` : ''}`,
  )
  const children = new Map<string, Array<FinishedSpan>>()
  for (const span of spans) {
    if (span.parentId !== null && ids.has(span.parentId)) {
      const list = children.get(span.parentId) ?? []
      list.push(span)
      children.set(span.parentId, list)
    }
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.startMs - b.startMs)
  }
  const orderedRoots = [...roots].sort((a, b) => a.startMs - b.startMs)
  orderedRoots.forEach((root, index) => {
    renderSpan(root, children, '', index === orderedRoots.length - 1, write)
  })
}

export type RequestTracing = {
  /** Provide to the request's Effect program to activate span collection. */
  tracer: Tracer.Tracer
  /** Finished spans in completion order; read for route summaries. */
  spans: Array<FinishedSpan>
  print: (header: TraceHeader, write?: (line: string) => void) => void
}

/** One collector per request: create, provide `tracer`, then `print`. */
export function createRequestTracing(): RequestTracing {
  const spans: Array<FinishedSpan> = []
  const tracer = Tracer.make({
    span: (options) =>
      new RecordingSpan(options, (span, exit) => {
        spans.push(toFinishedSpan(span, exit))
      }),
  })
  return {
    tracer,
    spans,
    print: (header, write = console.log) => printTrace(spans, header, write),
  }
}

/**
 * Name a traced step. Thin over `Effect.withSpan` so every flow shares the
 * naming convention; a no-op unless the request provided a tracer.
 */
export const withTraceSpan = (
  name: string,
  attributes?: Record<string, unknown>,
) =>
  Effect.withSpan(name, attributes === undefined ? undefined : { attributes })

/**
 * Record LLM token usage on the current step span. Skips silently when the SDK
 * result carries no usage (older providers, test doubles).
 */
export const annotateTokenUsage = (
  usage: { inputTokens?: number; outputTokens?: number } | null | undefined,
): Effect.Effect<void> => {
  if (usage == null) return Effect.void
  return Effect.all(
    [
      Effect.annotateCurrentSpan(
        'llm.usage.input_tokens',
        usage.inputTokens ?? 0,
      ),
      Effect.annotateCurrentSpan(
        'llm.usage.output_tokens',
        usage.outputTokens ?? 0,
      ),
    ],
    { discard: true },
  )
}
