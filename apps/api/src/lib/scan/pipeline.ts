import { generateText } from 'ai'
import { Effect } from 'effect'

import { DEFAULT_CATEGORIES } from '@spliit/domain'

import { getModel } from '../ai'
import { liftAiCall } from '../ai-effects/ai'
import {
  annotateTokenUsage,
  describeErrorValue,
  withTraceSpan,
} from '../ai-effects/spans'
import { extractAllowedIdFromAIResponse } from '../ai-response'
import { timeoutSecondsToMs } from '../ai/timeout'
import { classifyDocument } from '../documents/classify'
import { fetchDocumentBytes } from '../documents/fetch'
import { extractUsableDocumentText } from '../documents/pipeline'
import type { DocumentSource } from '../documents/types'
import { env } from '../env'
import { getOcrProvider, type OcrProvider } from '../ocr'
import {
  emptyReceiptResult,
  isEmptyReceiptResult,
  parseReceiptAIResponse,
  resolveReceiptCurrency,
  type GroupCurrencyInput,
} from './parse'
import { buildStructurePrompt, buildVisionPrompt } from './prompts'
import type {
  ReceiptAIContext,
  ReceiptCurrentExpenseHints,
  ReceiptExtractedResult,
} from './types'

/**
 * Receipt scan pipeline: document ingestion, text routing, and LLM calls as one
 * Effect composition. Runs once at the tRPC boundary via `Effect.runPromise`;
 * categorization stays in the procedure, which owns the group-context fetch and
 * the best-effort suggestion semantics.
 *
 * Routing:
 *
 * - `unsupported` documents skip AI entirely (empty result, file attached).
 * - PDFs and text documents try native text first; usable text goes to the
 *   text-only structuring call.
 * - Scanned-image PDFs fall back to the image flow (OCR provider, then vision);
 *   text documents without usable text yield an empty result (no image flow
 *   exists for office formats).
 * - Images keep the existing behavior: OCR provider first (unless strict mode
 *   fails the scan), vision LLM fallback.
 */

export type ScanReceiptDocumentDeps = {
  /**
   * Dedicated OCR backend. Defaults to the configured provider
   * (`getOcrProvider()`); tests inject fakes here instead of mocking modules.
   */
  ocr?: OcrProvider | null
  /**
   * Native document fetch/extraction budgets. Defaults apply in production;
   * tests pin `allowedHosts` to drive the native path deterministically.
   */
  fetchOptions?: {
    maxChars?: number
    maxBytes?: number
    maxPages?: number
    allowedHosts?: string[]
  }
}

type StructureContext = {
  locale?: string
  translateToLocale?: boolean
  currentExpense?: ReceiptCurrentExpenseHints
  /**
   * `ocr` for provider OCR output (warns the model about misreads), `document`
   * for natively extracted file text. Defaults to `document`.
   */
  origin?: 'ocr' | 'document'
}

/**
 * Structure extracted receipt text into fields with a fast text-only LLM call
 * (no image tokens). The category is always left null because the decision
 * model owns categorization on this path, exactly like `ocrOnly` vision mode.
 */
export const structureDocumentText = Effect.fnUntraced(function* (
  documentText: string,
  groupCurrencyInput: GroupCurrencyInput,
  context: StructureContext = {},
): Effect.fn.Return<ReceiptExtractedResult, unknown> {
  if (!documentText.trim()) {
    return emptyReceiptResult(groupCurrencyInput)
  }

  const prompt = buildStructurePrompt({
    origin: context.origin ?? 'document',
    documentText,
    groupCurrencyInput,
    locale: context.locale,
    translateToLocale: context.translateToLocale,
    currentExpense: context.currentExpense,
  })
  const model = yield* Effect.tryPromise({
    try: () => getModel(env.AI_RECEIPT_MODEL),
    // Pass through unwrapped so a provider/config failure keeps its message
    // at the tRPC boundary instead of surfacing as a generic Effect error.
    catch: (cause) => cause,
  })
  const { text: rawContent, usage } = yield* liftAiCall(
    () =>
      generateText({
        model,
        // Text-only call on the receipt model: no image tokens, same timeout
        // and no-retry policy as the vision path.
        maxRetries: 0,
        timeout: timeoutSecondsToMs(env.AI_RECEIPT_TIMEOUT_SECONDS),
        // Low temperature so the same text structures deterministically.
        temperature: 0.1,
        // Minimal reasoning: extraction is a direct structuring task, same as
        // the category verdict call. `'minimal'` is the lowest value the
        // endpoint accepts (`'none'` is rejected with a 400).
        reasoning: 'minimal',
        prompt,
      }),
    { timeoutSeconds: env.AI_RECEIPT_TIMEOUT_SECONDS },
  )
  // Token counts land on the enclosing `scan.structure` step span; a no-op
  // without an active tracer.
  yield* annotateTokenUsage(usage)
  // Raw output size distinguishes a verbose-but-legitimate receipt from a
  // reasoning/verbosity runaway when comparing against `output_tokens`.
  // Length only, never content: receipt text is PII and stays out of traces.
  yield* Effect.annotateCurrentSpan(
    'scan.structure.raw_chars',
    rawContent?.length ?? 0,
  )

  const parsed = parseReceiptAIResponse(rawContent)
  // The decision model owns categorization on this path; ignore any
  // hallucinated categoryId the structuring model returns unasked.
  parsed.categoryId = null
  resolveReceiptCurrency(parsed, groupCurrencyInput)
  return { ...parsed, empty: isEmptyReceiptResult(parsed), ocrUsed: true }
})

/**
 * Structure raw OCR-provider text. Same text-only call as native document text,
 * but framed as OCR output so the model allows for misread characters.
 */
export const structureOcrText = Effect.fnUntraced(function* (
  ocrText: string,
  groupCurrencyInput: GroupCurrencyInput,
  context: StructureContext = {},
): Effect.fn.Return<ReceiptExtractedResult, unknown> {
  if (!ocrText.trim()) {
    return emptyReceiptResult(groupCurrencyInput)
  }
  return yield* structureDocumentText(ocrText, groupCurrencyInput, {
    ...context,
    origin: 'ocr',
  })
})

const RECEIPT_CATEGORY_IDS = DEFAULT_CATEGORIES.map((category) => category.id)

function resolveVisionMediaType(
  source: DocumentSource,
  kind: 'image' | 'pdf',
): string {
  if (kind === 'pdf') return 'application/pdf'
  const contentType =
    source.contentType?.toLowerCase().split(';', 1)[0].trim() ?? ''
  if (contentType.startsWith('image/')) return contentType
  return 'image'
}

const extractWithVision = Effect.fnUntraced(function* (
  source: DocumentSource,
  kind: 'image' | 'pdf',
  groupCurrencyInput: GroupCurrencyInput,
  context: ReceiptAIContext & {
    currentExpense?: ReceiptCurrentExpenseHints
  },
  fetchOptions: {
    maxBytes?: number
    allowedHosts?: string[]
  } = {},
): Effect.fn.Return<ReceiptExtractedResult, unknown> {
  const ocrOnly = context.ocrOnly ?? false
  const prompt = buildVisionPrompt({
    noun: kind === 'pdf' ? 'document' : 'image',
    groupCurrencyInput,
    ocrOnly,
    locale: context.locale,
    translateToLocale: context.translateToLocale,
    groupContext: context.groupContext,
    recentExpenses: context.recentExpenses,
    currentExpense: context.currentExpense,
  })
  // Embed file bytes instead of passing the URL: providers fetch remote URLs
  // themselves and refuse S3/R2 receipt hosts whose origin serves no usable
  // robots.txt ("the origin's robots.txt disallows fetching this URL, or could
  // not be checked"). The server-side fetch reuses the SSRF-guarded downloader
  // (allowlisted storage hosts, byte cap), so private/presigned URLs work and
  // a crafted documentUrl cannot turn the vision call into a fetch proxy.
  const bytes = yield* Effect.gen(function* () {
    const data = yield* fetchDocumentBytes(source.url, {
      maxBytes: fetchOptions.maxBytes,
      allowedHosts: fetchOptions.allowedHosts,
    })
    yield* Effect.annotateCurrentSpan('scan.fetch.bytes', data.byteLength)
    return data
  }).pipe(withTraceSpan('scan.fetch'))
  const model = yield* Effect.tryPromise({
    try: () => getModel(env.AI_RECEIPT_MODEL),
    // Same passthrough as the structuring call above.
    catch: (cause) => cause,
  })
  const { text: rawContent, usage } = yield* liftAiCall(
    () =>
      generateText({
        model,
        // Bound slow self-hosted models so the tRPC handler cannot hang, and
        // fail fast instead of retrying an already-timed-out request.
        maxRetries: 0,
        timeout: timeoutSecondsToMs(env.AI_RECEIPT_TIMEOUT_SECONDS),
        // Minimal reasoning: extraction is a direct read-off-the-receipt
        // task. `'minimal'` is the floor every provider honors (see the
        // structuring call above for why not `'none'`).
        reasoning: 'minimal',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: resolveVisionMediaType(source, kind),
                data: bytes,
                filename: source.fileName ?? undefined,
              },
            ],
          },
        ],
      }),
    { timeoutSeconds: env.AI_RECEIPT_TIMEOUT_SECONDS },
  )
  // Token counts land on the enclosing `scan.vision` step span; a no-op
  // without an active tracer.
  yield* annotateTokenUsage(usage)

  const parsed = parseReceiptAIResponse(rawContent)
  if (ocrOnly) {
    // The decision model owns categorization on this path; ignore any
    // hallucinated categoryId the vision model returns unasked.
    parsed.categoryId = null
  } else {
    parsed.categoryId =
      extractAllowedIdFromAIResponse(parsed.categoryId, RECEIPT_CATEGORY_IDS) ??
      extractAllowedIdFromAIResponse(rawContent, RECEIPT_CATEGORY_IDS)
  }
  resolveReceiptCurrency(parsed, groupCurrencyInput)
  return { ...parsed, empty: isEmptyReceiptResult(parsed), ocrUsed: false }
})

/**
 * Scan one receipt document end to end (extraction only; categorization is the
 * procedure's job). Provider errors pass through unmapped so the procedure's
 * long-standing timeout/fallback mapping stays behavior-identical.
 */
export const scanReceiptDocument = Effect.fnUntraced(function* (
  source: DocumentSource,
  groupCurrencyInput: GroupCurrencyInput,
  context: ReceiptAIContext & {
    currentExpense?: ReceiptCurrentExpenseHints
  } = {},
  deps: ScanReceiptDocumentDeps = {},
): Effect.fn.Return<ReceiptExtractedResult, unknown> {
  const kind = classifyDocument(source)
  yield* Effect.annotateCurrentSpan('scan.document.kind', kind)
  if (kind === 'unsupported') {
    yield* Effect.annotateCurrentSpan('scan.extraction', 'unsupported')
    return emptyReceiptResult(groupCurrencyInput, false)
  }

  const ocr = deps.ocr !== undefined ? deps.ocr : getOcrProvider()
  const structureContext: StructureContext = {
    locale: context.locale,
    translateToLocale: context.translateToLocale,
    currentExpense: context.currentExpense,
  }

  if (kind === 'pdf' || kind === 'text-document') {
    const usable = yield* Effect.gen(function* () {
      const result = yield* extractUsableDocumentText(
        source,
        deps.fetchOptions ?? {},
      )
      yield* Effect.annotateCurrentSpan('scan.extract.outcome', result.kind)
      if (result.kind === 'text') {
        yield* Effect.annotateCurrentSpan(
          'scan.extract.chars',
          result.text.length,
        )
      }
      return result
    }).pipe(withTraceSpan('scan.extract', { 'scan.document.kind': kind }))
    if (usable.kind === 'text') {
      yield* Effect.annotateCurrentSpan('scan.extraction', 'text')
      return yield* structureDocumentText(
        usable.text,
        groupCurrencyInput,
        structureContext,
      ).pipe(
        withTraceSpan('scan.structure', {
          'llm.model': env.AI_RECEIPT_MODEL,
          'scan.structure.origin': 'document',
          'scan.structure.chars': usable.text.length,
        }),
      )
    }
    if (kind === 'text-document') {
      // No image flow exists for office/text formats: blank or garbled text
      // yields an empty result and the user fills in manually with the file
      // attached.
      yield* Effect.annotateCurrentSpan('scan.extraction', 'text-empty')
      return emptyReceiptResult(groupCurrencyInput, false)
    }
    // Scanned-image PDF: fall through to the image flow below.
  }

  // Dedicated OCR path: raw text from the configured provider, structured by
  // a fast text-only LLM call. Falls back to the vision call below unless
  // AI_OCR_REQUIRED pins strict mode.
  let ocrFailed = false
  if (ocr) {
    const ocrEffect = ocr.extractText(source.url, {
      timeoutMs: timeoutSecondsToMs(env.AI_OCRSPACE_TIMEOUT_SECONDS),
      contentType: source.contentType,
      fileName: source.fileName,
    })
    const ocrText = yield* Effect.gen(function* () {
      const effect = env.AI_OCR_REQUIRED
        ? ocrEffect
        : ocrEffect.pipe(
            // Record the failure before degrading: the trace then shows an
            // `ocr` step followed by a `vision-fallback` extraction, with the
            // provider's reason attached (quota and key errors fail fast and
            // look identical in timing alone).
            Effect.tapError((error) =>
              Effect.suspend(() => {
                ocrFailed = true
                return Effect.all(
                  [
                    Effect.annotateCurrentSpan('scan.ocr.failed', true),
                    Effect.annotateCurrentSpan(
                      'scan.ocr.error',
                      describeErrorValue(error),
                    ),
                  ],
                  { discard: true },
                )
              }),
            ),
            Effect.orElseSucceed(() => null),
          )
      const result = yield* effect
      if (result !== null) {
        yield* Effect.annotateCurrentSpan('scan.ocr.chars', result.text.length)
      }
      return result
    }).pipe(
      withTraceSpan('scan.ocr', {
        'scan.ocr.provider': ocr.name,
        'scan.ocr.strict': env.AI_OCR_REQUIRED,
      }),
    )
    // Strict mode fails the scan on OCR errors; otherwise a failed OCR step
    // degrades to the vision LLM below.
    if (ocrText !== null) {
      yield* Effect.annotateCurrentSpan('scan.extraction', 'ocr')
      return yield* structureOcrText(
        ocrText.text,
        groupCurrencyInput,
        structureContext,
      ).pipe(
        withTraceSpan('scan.structure', {
          'llm.model': env.AI_RECEIPT_MODEL,
          'scan.structure.origin': 'ocr',
          'scan.structure.chars': ocrText.text.length,
        }),
      )
    }
  }

  yield* Effect.annotateCurrentSpan(
    'scan.extraction',
    ocrFailed ? 'vision-fallback' : 'vision',
  )
  return yield* extractWithVision(
    source,
    kind === 'pdf' ? 'pdf' : 'image',
    groupCurrencyInput,
    context,
    deps.fetchOptions ?? {},
  ).pipe(
    withTraceSpan('scan.vision', {
      'llm.model': env.AI_RECEIPT_MODEL,
      'scan.vision.kind': kind === 'pdf' ? 'pdf' : 'image',
      'scan.vision.mode': (context.ocrOnly ?? false) ? 'ocr-only' : 'joint',
      'scan.vision.history': (context.recentExpenses?.length ?? 0) > 0,
    }),
  )
})

export type ReceiptExtractedInfo = ReceiptExtractedResult
