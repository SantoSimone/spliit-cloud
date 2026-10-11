import { Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { extractUsableDocumentText } from './pipeline'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

function textResponse(text: string) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe('extractUsableDocumentText', () => {
  it('returns usable text for a text document without touching the host guard', async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(
        'Corner Market\nApples 2 x 2.50\nBread 1 x 3.50\nTax 1.20\nTotal 18.50 USD\n2025-01-02\n',
      ),
    )

    const result = await run(
      extractUsableDocumentText(
        {
          url: 'https://files.example.test/receipt.txt',
          contentType: 'text/plain',
          fileName: 'receipt.txt',
        },
        { allowedHosts: ['files.example.test'] },
      ),
    )

    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.text).toContain('Corner Market')
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('collapses to none when the host is not allowlisted (SSRF guard)', async () => {
    const result = await run(
      extractUsableDocumentText(
        {
          url: 'https://evil.example.test/receipt.txt',
          contentType: 'text/plain',
          fileName: 'receipt.txt',
        },
        { allowedHosts: ['files.example.test'] },
      ),
    )

    expect(result).toEqual({ kind: 'none' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('collapses to none on download failures', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

    const result = await run(
      extractUsableDocumentText(
        {
          url: 'https://files.example.test/receipt.txt',
          contentType: 'text/plain',
          fileName: 'receipt.txt',
        },
        { allowedHosts: ['files.example.test'] },
      ),
    )

    expect(result).toEqual({ kind: 'none' })
  })

  it('collapses to none when the text fails the quality gate', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('### $$$ %%% ??? !!!'))

    const result = await run(
      extractUsableDocumentText(
        {
          url: 'https://files.example.test/receipt.txt',
          contentType: 'text/plain',
          fileName: 'receipt.txt',
        },
        { allowedHosts: ['files.example.test'] },
      ),
    )

    expect(result).toEqual({ kind: 'none' })
  })

  it('skips images and unsupported documents without fetching', async () => {
    for (const source of [
      {
        url: 'https://files.example.test/receipt.jpg',
        contentType: 'image/jpeg',
        fileName: 'receipt.jpg',
      },
      {
        url: 'https://files.example.test/legacy.doc',
        contentType: 'application/msword',
        fileName: 'legacy.doc',
      },
    ]) {
      const result = await run(
        extractUsableDocumentText(source, {
          allowedHosts: ['files.example.test'],
        }),
      )
      expect(result).toEqual({ kind: 'none' })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
