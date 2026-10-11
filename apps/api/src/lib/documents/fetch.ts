import { Effect } from 'effect'

import { DocumentFetchError } from '../ai-effects/errors'
import { env } from '../env'
import {
  DOCUMENT_FETCH_MAX_BYTES,
  DOCUMENT_FETCH_MAX_REDIRECTS,
  DOCUMENT_FETCH_TIMEOUT_SECONDS,
} from './types'

/**
 * Hosts the API may fetch receipt documents from for native text extraction and
 * vision embedding. Derived from the deployment's own storage configuration so
 * a crafted `documentUrl` cannot turn the scan endpoint into an SSRF proxy. The
 * OCR provider fetches the URL itself and is unaffected.
 *
 * Compared as `host` (hostname plus explicit port) so a same-hostname URL on an
 * unexpected port does not pass the guard.
 */
export function allowedDocumentHosts(): string[] {
  const hosts = new Set<string>()
  for (const raw of [env.S3_UPLOAD_PUBLIC_URL, env.S3_UPLOAD_ENDPOINT]) {
    if (!raw) continue
    try {
      hosts.add(new URL(raw).host.toLowerCase())
    } catch {
      // Ignore malformed endpoint config; the fetch simply refuses everything.
    }
  }
  return [...hosts]
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function isAllowedFetchUrl(parsed: URL, allowedHosts: string[]): boolean {
  return (
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    allowedHosts.includes(parsed.host.toLowerCase())
  )
}

/**
 * Download a receipt document for native parsing, capped in size. Failures
 * (refused host, network error, bad status) are typed `DocumentFetchError`s;
 * the scan pipeline treats them as "no native text" and falls back to the
 * OCR/vision path instead of failing the scan.
 */
export const fetchDocumentBytes = Effect.fnUntraced(function* (
  url: string,
  options: { maxBytes?: number; allowedHosts?: string[] } = {},
): Effect.fn.Return<Uint8Array, DocumentFetchError> {
  const maxBytes = options.maxBytes ?? DOCUMENT_FETCH_MAX_BYTES
  const allowedHosts = options.allowedHosts ?? allowedDocumentHosts()

  // Redirects are followed manually so every hop re-passes the allowlist:
  // the fetch runtime defaults to following cross-host redirects silently,
  // which would let an allowlisted URL bounce the server to an arbitrary
  // host. Only same-allowlist hops are followed, up to a small bound.
  let currentUrl = url
  for (let hop = 0; ; hop += 1) {
    let parsed: URL
    try {
      parsed = new URL(currentUrl)
    } catch {
      return yield* new DocumentFetchError({ reason: 'Invalid document URL' })
    }
    if (!isAllowedFetchUrl(parsed, allowedHosts)) {
      return yield* new DocumentFetchError({
        reason: `Refused document host: ${parsed.hostname}`,
      })
    }

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(DOCUMENT_FETCH_TIMEOUT_SECONDS * 1000),
        }),
      catch: () =>
        new DocumentFetchError({ reason: 'Document download failed' }),
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      if (hop >= DOCUMENT_FETCH_MAX_REDIRECTS) {
        return yield* new DocumentFetchError({
          reason: 'Too many document redirects',
        })
      }
      const headers = (response as Partial<Response>).headers
      const location = headers?.get('location') ?? null
      if (!location) {
        return yield* new DocumentFetchError({
          reason: 'Document redirect without location',
        })
      }
      try {
        currentUrl = new URL(location, currentUrl).toString()
      } catch {
        return yield* new DocumentFetchError({
          reason: 'Invalid document redirect location',
        })
      }
      continue
    }
    if (!response.ok) {
      return yield* new DocumentFetchError({
        reason: `Document download failed with status ${response.status}`,
      })
    }
    // Stream with the cap enforced during download: a large or slow object
    // yields only its prefix (often enough for the first receipt pages) and a
    // stalled store aborts via the signal above instead of hanging the scan.
    return yield* Effect.tryPromise({
      try: () => readCappedBytes(response, maxBytes),
      catch: () =>
        new DocumentFetchError({ reason: 'Document download failed' }),
    })
  }
})

/**
 * Read at most `maxBytes` of the response body, cancelling the stream once the
 * cap is reached. Partial prefixes are intentional: truncated PDFs still parse
 * their first pages, while truncated archives simply fail parsing and route to
 * the fallback — either way memory stays bounded pre-decompression.
 */
async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    return new Uint8Array((await response.arrayBuffer()).slice(0, maxBytes))
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const remaining = maxBytes - total
      if (remaining <= 0) break
      const take = value.subarray(0, remaining)
      chunks.push(take)
      total += take.length
      if (total >= maxBytes) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
