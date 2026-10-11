import { Schema } from 'effect'

/**
 * Shared typed errors for the Effect-based AI extraction pipelines (receipt
 * scan, voice expense). Procedures match on these at the tRPC boundary and map
 * them to stable `TRPCError` codes, so the wire contract never leaks Effect or
 * provider specifics.
 *
 * Deliberately narrow: LLM provider calls pass their original errors through
 * untouched (the procedures' duck-typed `isTimeoutError`/passthrough mapping
 * predates Effect and stays behavior-identical). Only stages that need new
 * attribution get new tags.
 */

/**
 * The API fetched a receipt document itself (native text extraction) and
 * failed.
 */
export class DocumentFetchError extends Schema.TaggedError<DocumentFetchError>()(
  'DocumentFetchError',
  {
    reason: Schema.String,
  },
) {}

/** Native text extraction (PDF text layer, docx, odt, plain text) failed. */
export class DocumentParseError extends Schema.TaggedError<DocumentParseError>()(
  'DocumentParseError',
  {
    contentType: Schema.String,
    reason: Schema.String,
  },
) {}
