import { Effect } from 'effect'

import { env } from '../env'
import {
  OcrError,
  type OcrExtractOptions,
  type OcrProvider,
  type OcrResult,
} from './types'

const OCRSPACE_ENDPOINT = 'https://api.ocr.space/parse/image'

type OcrSpaceParsedResult = {
  ParsedText?: string
  ErrorMessage?: string
  FileParseExitCode?: number
}

type OcrSpaceResponse = {
  ParsedResults?: OcrSpaceParsedResult[]
  IsErroredOnProcessing?: boolean
  ErrorMessage?: string | string[]
  OCRExitCode?: number
}

function joinErrorMessage(value: string | string[] | undefined): string {
  if (!value) return ''
  return Array.isArray(value) ? value.join('; ') : value
}

function isPdfContentType(contentType: string | null | undefined): boolean {
  return (
    contentType?.toLowerCase().split(';', 1)[0].trim() === 'application/pdf'
  )
}

function looksLikePdf(options: OcrExtractOptions): boolean {
  if (isPdfContentType(options.contentType)) return true
  // Extension fallback: presigned S3 URLs often carry a generic content type
  // (or none), mirroring classifyDocument.
  return (options.fileName ?? '').toLowerCase().endsWith('.pdf')
}

/** Best-effort response body preview for error messages; never fails. */
function readBodyPreview(response: Response): Effect.Effect<string, never> {
  return Effect.tryPromise({
    try: () => response.text(),
    catch: () => new Error('unreadable body'),
  }).pipe(
    Effect.map((text) => text.slice(0, 200)),
    Effect.orElseSucceed(() => ''),
  )
}

/**
 * OCR.space adapter (Engine 2, language autodetect).
 *
 * POST `/parse/image` with the remote `url`: unlike the GET `/parse/imageurl`
 * endpoint this also works when only the POST surface is reachable, accepts an
 * explicit `filetype` override (S3 presigned URLs often carry a generic content
 * type), and returns one `ParsedResults` entry per PDF page, which the adapter
 * joins. The receipt URL is passed straight through — no download or re-upload
 * on our side.
 */
export class OcrSpaceProvider implements OcrProvider {
  readonly name = 'ocrspace'

  extractText(
    documentUrl: string,
    options: OcrExtractOptions,
  ): Effect.Effect<OcrResult, OcrError> {
    return Effect.gen(function* () {
      const apiKey = env.AI_OCRSPACE_API_KEY
      if (!apiKey) {
        return yield* Effect.fail(
          new OcrError('AI_OCRSPACE_API_KEY is not configured', {
            retryable: false,
          }),
        )
      }

      const form = new FormData()
      form.set('url', documentUrl)
      // Engine 2 with autodetect covers traveling receipts whose language
      // differs from the user's app locale. Engine 3 is deliberately not
      // offered: it is much slower on photos and has a smaller free quota.
      form.set('language', 'auto')
      form.set('OCREngine', '2')
      form.set('isOverlayRequired', 'false')
      form.set('scale', 'true')
      form.set('detectOrientation', 'true')
      // Receipt-friendly line-by-line output for table-like documents.
      form.set('isTable', 'true')
      if (looksLikePdf(options)) {
        form.set('filetype', 'PDF')
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(OCRSPACE_ENDPOINT, {
            method: 'POST',
            headers: { apikey: apiKey },
            body: form,
            signal: AbortSignal.timeout(options.timeoutMs),
          }),
        catch: (cause) =>
          new OcrError('OCR.space request failed', {
            retryable: true,
            cause,
          }),
      })

      if (!response.ok) {
        const retryable =
          response.status === 429 ||
          response.status >= 500 ||
          response.status === 408
        // Body is best-effort; status alone is enough to classify.
        const detail = yield* readBodyPreview(response)
        return yield* Effect.fail(
          new OcrError(
            `OCR.space request failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
            { retryable },
          ),
        )
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<OcrSpaceResponse>,
        catch: (cause) =>
          new OcrError('OCR.space returned an unreadable response', {
            retryable: true,
            cause,
          }),
      })

      if (body.IsErroredOnProcessing) {
        const message =
          joinErrorMessage(body.ErrorMessage) ||
          'OCR.space could not process the document'
        // Free-tier quota errors surface here, not as HTTP 429.
        const retryable = /limit|maximum|quota|allowed|busy|timeout/i.test(
          message,
        )
        return yield* Effect.fail(
          new OcrError(`OCR.space error: ${message}`, { retryable }),
        )
      }

      const pages = body.ParsedResults ?? []
      const texts = pages
        .map((page) => page.ParsedText ?? '')
        .filter((text) => text.trim() !== '')
      if (texts.length > 0) {
        return { text: texts.join('\n'), engine: 'ocrspace-2' }
      }
      if (pages.length === 0) {
        return yield* Effect.fail(
          new OcrError('OCR.space returned no results', { retryable: false }),
        )
      }

      // No usable page: surface the first per-page error when there is one,
      // otherwise return blank text (the caller maps it to an empty result).
      const pageError = pages
        .map((page) => page.ErrorMessage?.trim())
        .find((message) => message)
      if (pageError) {
        return yield* Effect.fail(
          new OcrError(`OCR.space error: ${pageError}`, { retryable: false }),
        )
      }
      return { text: '', engine: 'ocrspace-2' }
    })
  }
}
