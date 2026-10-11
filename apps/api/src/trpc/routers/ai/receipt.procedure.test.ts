import { Duration, Effect } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../test/mocks'
import { prismaMock } from '../../../test/state'

const envState = vi.hoisted(() => ({
  PUBLIC_ENABLE_RECEIPT_EXTRACT: false,
  PUBLIC_ENABLE_CATEGORY_EXTRACT: false,
  AI_CATEGORY_ENGINE: 'llm' as 'llm' | 'system-one',
  AI_RECEIPT_TIMEOUT_SECONDS: 120,
  AI_OCR_PROVIDER: 'none' as 'none' | 'ocrspace',
  AI_OCRSPACE_TIMEOUT_SECONDS: 30,
}))

const scanReceiptDocument = vi.hoisted(() => vi.fn())
const suggestExpenseCategory = vi.hoisted(() => vi.fn())

vi.mock(import('../../../lib/env'), async (importOriginal) => {
  const actual = await importOriginal()
  const mockedEnv = { ...actual.env }
  for (const key of Object.keys(envState) as (keyof typeof envState)[]) {
    Object.defineProperty(mockedEnv, key, {
      enumerable: true,
      configurable: true,
      get: () => envState[key],
    })
  }
  return { ...actual, env: mockedEnv }
})

vi.mock(import('../../../lib/scan/pipeline'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    scanReceiptDocument,
  }
})

vi.mock(
  import('../../../lib/api/expenses/suggest-category'),
  async (importOriginal) => {
    const actual = await importOriginal()
    return {
      ...actual,
      suggestExpenseCategory,
    }
  },
)

const tracingState = vi.hoisted(() => ({
  current: null as null | {
    spans: Array<{ name: string; attributes: Record<string, unknown> }>
  },
}))

vi.mock(import('../../../lib/ai-effects/spans'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createRequestTracing: () => {
      const tracing = actual.createRequestTracing()
      tracingState.current = tracing
      return tracing
    },
  }
})

import { aiRouter } from '.'
import { buildScanRoute } from './receipt.procedure'

function authenticatedCaller() {
  return aiRouter.createCaller({
    auth: {
      session: { id: 'session-1' },
      user: {
        id: 'account-1',
        email: 'alice@example.test',
        emailVerified: true,
        name: 'Alice',
      },
    },
  } as never)
}

const scanInput = {
  documentUrl: 'https://example.test/receipt.jpg',
  contentType: 'image/jpeg',
  fileName: 'receipt.jpg',
  currency: '$',
  currencyCode: 'USD',
  groupId: 'group-1',
}

beforeEach(() => {
  envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = false
  envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = false
  envState.AI_CATEGORY_ENGINE = 'llm'
  envState.AI_OCR_PROVIDER = 'none'
  scanReceiptDocument.mockReset()
  suggestExpenseCategory.mockReset()
  tracingState.current = null
  suggestExpenseCategory.mockResolvedValue({
    categoryId: null,
    candidates: [],
  })
  prismaMock.group.findUnique.mockResolvedValue({
    id: 'group-1',
    ledger: { id: 'ledger-1', currency: '$', currencyCode: 'USD' },
  } as never)
  prismaMock.groupMember.findUnique.mockResolvedValue({
    status: 'ACTIVE',
  } as never)
  prismaMock.expense.findMany.mockResolvedValue([])
})

describe('receipt extraction authorization', () => {
  it('rejects anonymous requests before invoking receipt extraction', async () => {
    const caller = aiRouter.createCaller({ auth: null })

    await expect(
      caller.extractExpenseInformationFromImage({
        documentUrl: 'https://example.test/receipt.jpg',
        currency: '$',
        currencyCode: 'USD',
        groupId: 'group-1',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('enforces the server feature flag for authenticated requests', async () => {
    const caller = authenticatedCaller()

    await expect(
      caller.extractExpenseInformationFromImage({
        documentUrl: 'https://example.test/receipt.jpg',
        currency: '$',
        currencyCode: 'USD',
        groupId: 'group-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('maps provider timeouts to a TIMEOUT error instead of hanging silently', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    scanReceiptDocument.mockReturnValueOnce(
      Effect.fail(
        new DOMException('total timeout of 120000ms exceeded', 'TimeoutError'),
      ),
    )
    const caller = authenticatedCaller()

    await expect(
      caller.extractExpenseInformationFromImage(scanInput),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Receipt scanning failed due to timeout after 120s',
    })
  })

  it('maps real Effect timeout failures to TIMEOUT with the receipt budget', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    // A genuine `Effect.timeout` failure (not a mocked DOMException) traveling
    // through `Effect.runPromise` must still map to TIMEOUT at the boundary.
    scanReceiptDocument.mockReturnValueOnce(
      Effect.timeout(Effect.never, Duration.millis(10)),
    )
    const caller = authenticatedCaller()

    await expect(
      caller.extractExpenseInformationFromImage(scanInput),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Receipt scanning failed due to timeout after 120s',
    })
  })

  it('lets non-timeout provider errors propagate unchanged', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    scanReceiptDocument.mockReturnValueOnce(
      Effect.fail(new Error('AI service unavailable')),
    )
    const caller = authenticatedCaller()

    await expect(
      caller.extractExpenseInformationFromImage(scanInput),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})

describe('receipt extraction categorization', () => {
  const ocrResult = {
    amount: 1850,
    categoryId: null,
    currencyCode: 'USD',
    date: '2025-01-02',
    title: 'Corner Market',
    items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
  }

  it('keeps the joint vision call and skips the decision model with the llm engine', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'llm'
    scanReceiptDocument.mockReturnValueOnce(
      Effect.succeed({
        ...ocrResult,
        categoryId: 'groceries',
      }),
    )
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.categoryId).toBe('groceries')
    const [source, , context] = scanReceiptDocument.mock.calls[0] as [
      { url: string; contentType: string; fileName: string },
      unknown,
      { ocrOnly?: boolean; recentExpenses?: unknown[] },
    ]
    expect(source).toMatchObject({
      url: 'https://example.test/receipt.jpg',
      contentType: 'image/jpeg',
      fileName: 'receipt.jpg',
    })
    expect(context.ocrOnly).not.toBe(true)
    expect(context.recentExpenses).toBeDefined()
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })

  it('runs OCR-only vision plus the decision model with the system-one engine', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(ocrResult))
    suggestExpenseCategory.mockResolvedValueOnce({
      categoryId: 'groceries',
      candidates: [],
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result).toMatchObject({ ...ocrResult, categoryId: 'groceries' })
    const [, , context] = scanReceiptDocument.mock.calls[0] as [
      unknown,
      unknown,
      { ocrOnly?: boolean; recentExpenses?: unknown },
    ]
    expect(context.ocrOnly).toBe(true)
    expect(context.recentExpenses).toBeUndefined()
    expect(suggestExpenseCategory).toHaveBeenCalledWith({
      groupId: 'group-1',
      title: 'Corner Market',
      locale: undefined,
      allowAi: true,
      receiptItems: ['Apples'],
      receiptCurrencyCode: 'USD',
      beforeAi: expect.any(Function),
    })
    // No history fetch for the OCR path; the decision model loads its own.
    expect(prismaMock.expense.findMany).not.toHaveBeenCalled()
  })

  it('degrades to a null category when the decision model fails', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(ocrResult))
    suggestExpenseCategory.mockRejectedValueOnce(new Error('model down'))
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result).toMatchObject({ ...ocrResult, categoryId: null })
  })

  it('skips the decision model when OCR returns no title', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    scanReceiptDocument.mockReturnValueOnce(
      Effect.succeed({
        ...ocrResult,
        title: null,
      }),
    )
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.categoryId).toBeNull()
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })
})

describe('receipt extraction with a dedicated OCR provider', () => {
  const ocrResult = {
    amount: 1850,
    categoryId: null,
    currencyCode: 'USD',
    date: '2025-01-02',
    title: 'Corner Market',
    items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
    empty: false,
    ocrUsed: true,
  }

  it('runs the separate suggestion step with the llm engine on OCR results', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'llm'
    envState.AI_OCR_PROVIDER = 'ocrspace'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(ocrResult))
    suggestExpenseCategory.mockResolvedValueOnce({
      categoryId: 'groceries',
      candidates: [],
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    // `ocrUsed` is an internal routing flag and is stripped from the output.
    const { ocrUsed: _ocrUsed, ...expectedOutput } = ocrResult
    expect(result).toMatchObject({ ...expectedOutput, categoryId: 'groceries' })
    expect(result).not.toHaveProperty('ocrUsed')
    expect(suggestExpenseCategory).toHaveBeenCalledWith({
      groupId: 'group-1',
      title: 'Corner Market',
      locale: undefined,
      allowAi: true,
      receiptItems: ['Apples'],
      receiptCurrencyCode: 'USD',
      beforeAi: expect.any(Function),
    })
    // No history fetch for the OCR path; the suggestion loads its own.
    expect(prismaMock.expense.findMany).not.toHaveBeenCalled()
  })

  it('passes the empty flag through to the client', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_OCR_PROVIDER = 'ocrspace'
    scanReceiptDocument.mockReturnValueOnce(
      Effect.succeed({
        amount: Number.NaN,
        categoryId: null,
        currencyCode: 'USD',
        date: null,
        title: null,
        items: [],
        empty: true,
        ocrUsed: true,
      }),
    )
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.empty).toBe(true)
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })

  it('keeps the joint vision path when OCR fell back without ocrUsed', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'llm'
    envState.AI_OCR_PROVIDER = 'ocrspace'
    scanReceiptDocument.mockReturnValueOnce(
      Effect.succeed({
        ...ocrResult,
        categoryId: 'groceries',
        ocrUsed: false,
      }),
    )
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.categoryId).toBe('groceries')
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })

  it('names the OCR timeout budget when the OCR stage times out', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.AI_OCR_PROVIDER = 'ocrspace'
    const { OcrError } = await import('../../../lib/ocr')
    // Mirrors the adapter's timeout shape: fetch aborts with a TimeoutError
    // DOMException, wrapped in an OcrError whose cause still matches the
    // duck-typed timeout check while the stage flag selects the OCR budget.
    scanReceiptDocument.mockReturnValueOnce(
      Effect.fail(
        new OcrError('OCR.space request failed', {
          retryable: true,
          cause: new DOMException('Timeout', 'TimeoutError'),
        }),
      ),
    )
    const caller = authenticatedCaller()

    await expect(
      caller.extractExpenseInformationFromImage(scanInput),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Receipt scanning failed due to timeout after 30s',
    })
  })

  it('accepts PDF documents with content type and file name', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.AI_OCR_PROVIDER = 'ocrspace'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(ocrResult))
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage({
      documentUrl: 'https://example.test/invoice.pdf',
      contentType: 'application/pdf',
      fileName: 'invoice.pdf',
      currency: '$',
      currencyCode: 'USD',
      groupId: 'group-1',
    })

    const [source] = scanReceiptDocument.mock.calls[0] as [
      { url: string; contentType: string; fileName: string },
    ]
    expect(source).toMatchObject({
      url: 'https://example.test/invoice.pdf',
      contentType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
    expect(result.title).toBe('Corner Market')
  })

  it('suggests a category for native document text without an OCR provider', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'llm'
    envState.AI_OCR_PROVIDER = 'none'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(ocrResult))
    suggestExpenseCategory.mockResolvedValueOnce({
      categoryId: 'groceries',
      candidates: [],
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    // Structured-text results (native PDF/office text) carry ocrUsed even
    // when no OCR provider is configured; the suggestion must still run
    // (ocrUsed is stripped from the output like on the OCR path).
    const { ocrUsed: _ocrUsed, ...expectedOutput } = ocrResult
    expect(result).toMatchObject({ ...expectedOutput, categoryId: 'groceries' })
    expect(suggestExpenseCategory).toHaveBeenCalledWith({
      groupId: 'group-1',
      title: 'Corner Market',
      locale: undefined,
      allowAi: true,
      receiptItems: ['Apples'],
      receiptCurrencyCode: 'USD',
      beforeAi: expect.any(Function),
    })
  })
})

describe('receipt extraction tracing', () => {
  const tracedResult = {
    amount: 1850,
    categoryId: null,
    currencyCode: 'USD',
    date: '2025-01-02',
    title: 'Corner Market',
    items: [{ title: 'Apples', unitPrice: 250, quantity: 2000 }],
    ocrUsed: true,
    empty: false,
  }

  it('profiles the separate categorization with engine and hit attributes', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(tracedResult))
    suggestExpenseCategory.mockImplementationOnce(
      async (args: { beforeAi?: () => void }) => {
        args.beforeAi?.()
        return { categoryId: 'groceries', candidates: [] }
      },
    )
    const caller = authenticatedCaller()

    await caller.extractExpenseInformationFromImage(scanInput)

    const spans = tracingState.current?.spans ?? []
    expect(spans.map((span) => span.name)).toContain('scan.categorize')
    expect(
      spans.find((span) => span.name === 'scan.categorize')?.attributes,
    ).toMatchObject({
      'scan.categorize.engine': 'system-one',
      'scan.categorize.ai_ran': true,
      'scan.categorize.hit': true,
    })
  })

  it('records a local-dictionary hit when the AI engine never runs', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    scanReceiptDocument.mockReturnValueOnce(Effect.succeed(tracedResult))
    // Mock never invokes `beforeAi`: the local stages answered directly.
    suggestExpenseCategory.mockResolvedValueOnce({
      categoryId: 'groceries',
      candidates: [],
    })
    const caller = authenticatedCaller()

    await caller.extractExpenseInformationFromImage(scanInput)

    expect(
      tracingState.current?.spans.find(
        (span) => span.name === 'scan.categorize',
      )?.attributes,
    ).toMatchObject({
      'scan.categorize.ai_ran': false,
      'scan.categorize.hit': true,
    })
  })
})

describe('buildScanRoute', () => {
  const root = (extraction: string) => [
    {
      id: 'root',
      parentId: null,
      name: 'scan.receipt',
      startMs: 0,
      durationMs: 100,
      attributes: { 'scan.extraction': extraction },
      error: null,
    },
  ]

  it('combines extraction and categorization branches', () => {
    expect(buildScanRoute(root('ocr'), 'separate', 'system-one')).toBe(
      'ocr+separate(system-one)',
    )
    expect(buildScanRoute(root('vision'), 'inline')).toBe('vision+inline')
    expect(buildScanRoute(root('text'), 'none')).toBe('text+none')
    expect(buildScanRoute(root('vision-fallback'), 'separate', 'llm')).toBe(
      'vision-fallback+separate(llm)',
    )
  })

  it('falls back to unknown without a receipt span', () => {
    expect(buildScanRoute([], 'inline')).toBe('unknown+inline')
  })
})
