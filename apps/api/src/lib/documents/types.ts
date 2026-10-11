/**
 * Document ingestion types for AI receipt scanning.
 *
 * Receipts arrive as images (photos) or as documents (PDF invoices, text
 * exports, office files). This layer normalizes them: native text is extracted
 * when the format carries a text layer, otherwise the document routes to the
 * image flow (OCR provider or vision LLM).
 */

/**
 * A receipt file by reference. The API downloads it server-side for native
 * parsing and for vision embedding (bytes, never a remote URL).
 */
export type DocumentSource = {
  /** Publicly reachable file URL (S3/R2 `fileUrl` from the upload presign). */
  url: string
  /** MIME type as uploaded, if known. */
  contentType?: string | null
  /** Original file name, used as an extension fallback. */
  fileName?: string | null
}

/**
 * How a document is processed:
 *
 * - `image`: existing photo flow (OCR provider or vision LLM).
 * - `pdf`: native text-layer extraction first, image flow as fallback.
 * - `text-document`: native text extraction (txt/csv/docx/odt); no image fallback
 *   exists, so a failed extraction yields an empty result and the user fills
 *   the expense in manually with the file attached.
 * - `unsupported`: legacy/spreadsheet formats with no extraction path; same
 *   manual-with-attachment outcome without burning AI budget.
 */
export type DocumentKind = 'image' | 'pdf' | 'text-document' | 'unsupported'

/** Native extraction reads at most this many PDF pages (free OCR tier: 3). */
export const NATIVE_TEXT_MAX_PAGES = 3

/** Native text is truncated to this many characters before the LLM sees it. */
export const NATIVE_TEXT_MAX_CHARS = 15_000

/** Server-side document fetch aborts past this many bytes (zip-bomb guard). */
export const DOCUMENT_FETCH_MAX_BYTES = 8 * 1024 * 1024

/** Budget for the server-side document fetch itself (inside AI budgets). */
export const DOCUMENT_FETCH_TIMEOUT_SECONDS = 15

/** Maximum same-allowlist redirect hops followed during the document fetch. */
export const DOCUMENT_FETCH_MAX_REDIRECTS = 3
