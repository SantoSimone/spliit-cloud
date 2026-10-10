import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../../../test/mocks'
import { prismaMock } from '../../../test/state'

const envState = vi.hoisted(() => ({
  PUBLIC_ENABLE_RECEIPT_EXTRACT: false,
  PUBLIC_ENABLE_CATEGORY_EXTRACT: false,
  AI_CATEGORY_ENGINE: 'llm' as 'llm' | 'system-one',
  AI_RECEIPT_TIMEOUT_SECONDS: 120,
}))

const extractExpenseInformationFromImage = vi.hoisted(() => vi.fn())
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

vi.mock(import('../../../lib/receipt-actions'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    extractExpenseInformationFromImage,
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

import { aiRouter } from '.'

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
  imageUrl: 'https://example.test/receipt.jpg',
  currency: '$',
  currencyCode: 'USD',
  groupId: 'group-1',
}

beforeEach(() => {
  envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = false
  envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = false
  envState.AI_CATEGORY_ENGINE = 'llm'
  extractExpenseInformationFromImage.mockReset()
  suggestExpenseCategory.mockReset()
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
        imageUrl: 'https://example.test/receipt.jpg',
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
        imageUrl: 'https://example.test/receipt.jpg',
        currency: '$',
        currencyCode: 'USD',
        groupId: 'group-1',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('maps provider timeouts to a TIMEOUT error instead of hanging silently', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    extractExpenseInformationFromImage.mockRejectedValueOnce(
      new DOMException('total timeout of 120000ms exceeded', 'TimeoutError'),
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
    extractExpenseInformationFromImage.mockRejectedValueOnce(
      new Error('AI service unavailable'),
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
    items: [{ title: 'Apples', unitPrice: 2.5, quantity: 2 }],
  }

  it('keeps the joint vision call and skips the decision model with the llm engine', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'llm'
    extractExpenseInformationFromImage.mockResolvedValueOnce({
      ...ocrResult,
      categoryId: 'groceries',
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.categoryId).toBe('groceries')
    const [, , context] = extractExpenseInformationFromImage.mock.calls[0] as [
      unknown,
      unknown,
      { ocrOnly?: boolean; recentExpenses?: unknown[] },
    ]
    expect(context.ocrOnly).not.toBe(true)
    expect(context.recentExpenses).toBeDefined()
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })

  it('runs OCR-only vision plus the decision model with the system-one engine', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    extractExpenseInformationFromImage.mockResolvedValueOnce(ocrResult)
    suggestExpenseCategory.mockResolvedValueOnce({
      categoryId: 'groceries',
      candidates: [],
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result).toMatchObject({ ...ocrResult, categoryId: 'groceries' })
    const [, , context] = extractExpenseInformationFromImage.mock.calls[0] as [
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
    })
    // No history fetch for the OCR path; the decision model loads its own.
    expect(prismaMock.expense.findMany).not.toHaveBeenCalled()
  })

  it('degrades to a null category when the decision model fails', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    extractExpenseInformationFromImage.mockResolvedValueOnce(ocrResult)
    suggestExpenseCategory.mockRejectedValueOnce(new Error('model down'))
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result).toMatchObject({ ...ocrResult, categoryId: null })
  })

  it('skips the decision model when OCR returns no title', async () => {
    envState.PUBLIC_ENABLE_RECEIPT_EXTRACT = true
    envState.PUBLIC_ENABLE_CATEGORY_EXTRACT = true
    envState.AI_CATEGORY_ENGINE = 'system-one'
    extractExpenseInformationFromImage.mockResolvedValueOnce({
      ...ocrResult,
      title: null,
    })
    const caller = authenticatedCaller()

    const result = await caller.extractExpenseInformationFromImage(scanInput)

    expect(result.categoryId).toBeNull()
    expect(suggestExpenseCategory).not.toHaveBeenCalled()
  })
})
