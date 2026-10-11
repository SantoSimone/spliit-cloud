import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchDocumentBytes } from './fetch'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const flip = <A, E>(effect: Effect.Effect<A, E>) =>
  run(effect.pipe(Effect.flip))

function chunkStream(chunks: Uint8Array[], cancel: () => Promise<void>) {
  const queue = [...chunks]
  return {
    getReader: () => ({
      read: async () => {
        const value = queue.shift()
        return value ? { done: false, value } : { done: true, value: undefined }
      },
      cancel,
    }),
  }
}

describe('fetchDocumentBytes', () => {
  it('refuses hosts outside the allowlist without fetching (SSRF guard)', async () => {
    const error = await flip(
      fetchDocumentBytes('https://evil.example.test/receipt.txt', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses non-http(s) URLs', async () => {
    const error = await flip(
      fetchDocumentBytes('file:///etc/passwd', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds the fetch with an abort signal and caps streamed bytes', async () => {
    const chunks = Array.from({ length: 5 }, () =>
      new TextEncoder().encode('0123456789'),
    )
    const cancel = vi.fn(async () => undefined)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: chunkStream(chunks, cancel),
    })

    const bytes = await run(
      fetchDocumentBytes('https://files.example.test/big.pdf', {
        maxBytes: 25,
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(bytes.length).toBe(25)
    // The stream is cancelled once the cap is reached instead of draining.
    expect(cancel).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { signal?: AbortSignal },
    ]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to arrayBuffer when the body stream is unavailable', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () =>
        new TextEncoder().encode('hello 123').buffer as ArrayBuffer,
    })

    const bytes = await run(
      fetchDocumentBytes('https://files.example.test/receipt.txt', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(new TextDecoder().decode(bytes)).toBe('hello 123')
  })

  it('maps bad statuses to a typed error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })

    const error = await flip(
      fetchDocumentBytes('https://files.example.test/receipt.txt', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
  })

  it('refuses cross-host redirects without following them (SSRF guard)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location'
            ? 'https://evil.example.test/steal'
            : null,
      },
    })

    const error = await flip(
      fetchDocumentBytes('https://files.example.test/receipt.pdf', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
    // The redirect target is never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { redirect?: RequestRedirect },
    ]
    expect(init.redirect).toBe('manual')
  })

  it('follows same-allowlist redirects and enforces the hop bound', async () => {
    const cancel = vi.fn(async () => undefined)
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location'
              ? 'https://files.example.test/final.pdf'
              : null,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: chunkStream([new TextEncoder().encode('hello 123')], cancel),
      })

    const bytes = await run(
      fetchDocumentBytes('https://files.example.test/start.pdf', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(new TextDecoder().decode(bytes)).toBe('hello 123')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects redirect chains past the hop bound', async () => {
    const redirectToSelf = {
      ok: false,
      status: 302,
      headers: { get: () => 'https://files.example.test/loop.pdf' },
    }
    fetchMock.mockResolvedValue(redirectToSelf)

    const error = await flip(
      fetchDocumentBytes('https://files.example.test/loop.pdf', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('refuses same-hostname URLs on unexpected ports', async () => {
    const error = await flip(
      fetchDocumentBytes('https://files.example.test:8080/receipt.txt', {
        allowedHosts: ['files.example.test'],
      }),
    )

    expect(error._tag).toBe('DocumentFetchError')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
