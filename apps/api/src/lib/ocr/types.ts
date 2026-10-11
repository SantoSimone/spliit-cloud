/** Raw text extracted from a receipt document by an OCR provider. */
export type OcrResult = {
  /** Extracted text, possibly empty when nothing readable was found. */
  text: string
  /** Provider-side engine label for observability (e.g. `ocrspace-2`). */
  engine: string
}

export type OcrExtractOptions = {
  /** Abort budget in milliseconds for the provider request. */
  timeoutMs: number
  /** MIME type of the scanned document, if known (drives `filetype`). */
  contentType?: string | null
  /**
   * Original file name; extension fallback for `filetype` when the MIME type is
   * generic.
   */
  fileName?: string | null
}

/**
 * OCR-stage failure. `retryable` marks transient failures (rate limits, 5xx,
 * network errors, timeouts) where falling back to the vision LLM makes sense;
 * permanent failures (bad key, unsupported file) are not retryable.
 */
export class OcrError extends Error {
  readonly retryable: boolean
  readonly stage = 'ocr' as const

  constructor(
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message)
    this.name = 'OcrError'
    this.retryable = options.retryable ?? false
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

import type { Effect } from 'effect'

/** True for errors raised by an {@link OcrProvider} (any stage). */
export function isOcrError(error: unknown): error is OcrError {
  return error instanceof OcrError
}

/**
 * One OCR backend. Adding a provider means implementing this interface plus a
 * factory case in `./index` — callers never touch provider specifics.
 *
 * Effect-based: callers compose the extraction into the scan pipeline and run
 * it once at the tRPC boundary. Failures stay `OcrError` so the existing
 * retryable/fallback contract is unchanged.
 */
export interface OcrProvider {
  readonly name: string
  extractText(
    documentUrl: string,
    options: OcrExtractOptions,
  ): Effect.Effect<OcrResult, OcrError>
}
