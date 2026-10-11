import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AiExpensePreview,
  type AiExpenseDraft,
} from '@/app/groups/[groupId]/expenses/ai-expense-preview'
import { act, render, screen } from '@/test/test-utils'
import { getCurrency, getItemizedFormMinorTotals } from '@spliit/domain'

vi.mock('@/app/groups/[groupId]/expenses/expense-mutation-hooks', () => ({
  useCreateExpenseMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

const linkSearches: Array<Record<string, unknown>> = []
vi.mock('@tanstack/react-router', () => ({
  Link: (props: { search?: Record<string, unknown> }) => {
    linkSearches.push(props.search ?? {})
    return <span>edit-link</span>
  },
}))

const group = {
  id: 'group-1',
  name: 'Trip',
  currency: '$',
  currencyCode: 'USD',
  participants: [
    { id: 'p1', name: 'Ann' },
    { id: 'p2', name: 'Bo' },
  ],
} as never

const USD = getCurrency('USD')!

function receiptDraft(
  items: NonNullable<AiExpenseDraft['items']>,
  amountMinor: number,
): AiExpenseDraft {
  return {
    source: 'receipt',
    title: 'Test Store',
    amount: amountMinor,
    amountUnit: 'minor',
    currencyCode: 'USD',
    date: '2025-01-01',
    categoryId: null,
    items,
    issues: [],
  }
}

function renderPreview(draft: AiExpenseDraft) {
  return render(
    <AiExpensePreview
      open
      onOpenChange={() => undefined}
      group={group}
      currentLedgerParticipantId={null}
      draft={draft}
    />,
  )
}

function lastHandoffItems(): Array<{
  title: string
  unitPrice: number
  quantity: number
}> {
  const raw = linkSearches.at(-1)?.items
  expect(typeof raw).toBe('string')
  return JSON.parse(raw as string) as Array<{
    title: string
    unitPrice: number
    quantity: number
  }>
}

function lastHandoffAmountMinor(): number {
  const raw = linkSearches.at(-1)?.amount
  expect(typeof raw).toBe('string')
  return Number(raw)
}

beforeEach(() => {
  linkSearches.length = 0
})

function totalRadio() {
  return screen.getByRole('radio', { name: /receipt total/i })
}

function itemsRadio() {
  return screen.getByRole('radio', { name: /items total/i })
}

describe('AiExpensePreview rounding-size gap', () => {
  it('preselects the receipt total', () => {
    // 2 × $2.50 = $5.00 scanned against a $5.05 total: a +$0.05 gap within
    // the last two minor-unit digits. The choice is immediate,
    // defaulting to the receipt total with a rounding row.
    renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 505),
    )

    expect(screen.getByText(/difference/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(totalRadio()).toBeChecked()
    expect(itemsRadio()).not.toBeChecked()
    // The rounding row flows into the handoff but never renders as a list
    // row: the choice is its only UI.
    expect(screen.queryByText('Rounding')).not.toBeInTheDocument()
    expect(screen.getByText('Apples')).toBeInTheDocument()
    // Either choice balances, so one-click create is available.
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(2)
    expect(handedOff[1]).toEqual({
      title: 'Rounding',
      unitPrice: 0.05,
      quantity: 1,
    })
    expect(lastHandoffAmountMinor()).toBe(505)
    expect(getItemizedFormMinorTotals(handedOff, 5.05, USD).gapMinor).toBe(0)
  })

  it('treats a 99-minor gap as rounding but a 100-minor gap as a mismatch', () => {
    const { rerender } = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 599),
    )
    // $0.99 gap: rounding wording, preselected receipt total.
    expect(totalRadio()).toBeChecked()
    expect(totalRadio()).toHaveAccessibleName(/rounding/i)

    rerender(
      <AiExpensePreview
        open
        onOpenChange={() => undefined}
        group={group}
        currentLedgerParticipantId={null}
        draft={receiptDraft(
          [{ title: 'Apples', unitPrice: 2.5, quantity: 2 }],
          600,
        )}
      />,
    )
    // $1.00 gap: "Other" wording with the mismatch note, still
    // preselected and immediately actionable.
    expect(totalRadio()).toBeChecked()
    expect(totalRadio()).toHaveAccessibleName(/as other/i)
    expect(screen.getByText(/more than rounding/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()
  })

  it('rewrites the amount to the items total when items win', async () => {
    const { user } = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 505),
    )

    await user.click(itemsRadio())
    expect(itemsRadio()).toBeChecked()
    expect(totalRadio()).not.toBeChecked()

    // No adjustment row: the expense amount becomes the items sum.
    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(1)
    expect(lastHandoffAmountMinor()).toBe(500)
    expect(getItemizedFormMinorTotals(handedOff, 5, USD).gapMinor).toBe(0)
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()
  })

  it('hides the notice when scanned items already cover the total', () => {
    renderPreview(
      receiptDraft(
        [
          { title: 'Apples', unitPrice: 2.5, quantity: 2 },
          { title: 'Bread', unitPrice: 3.5, quantity: 1 },
        ],
        850,
      ),
    )

    expect(screen.queryByText(/difference/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('offers a signed rounding option when items exceed the total by cents', async () => {
    const { user } = renderPreview(
      receiptDraft(
        [
          { title: 'Apples', unitPrice: 2.5, quantity: 2 },
          { title: 'Bread', unitPrice: 3.5, quantity: 1 },
        ],
        800,
      ),
    )

    // $8.50 of items against an $8.00 total: a −$0.50 gap, preselected on
    // the receipt total. The option reads "Subtract …", never "Add -$0.50 …".
    expect(totalRadio()).toBeChecked()
    expect(totalRadio()).toHaveAccessibleName(/subtract \$0\.50 rounding/i)
    expect(screen.queryByText('Rounding')).not.toBeInTheDocument()

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(3)
    expect(handedOff[2]).toEqual({
      title: 'Rounding',
      unitPrice: -0.5,
      quantity: 1,
    })
    expect(getItemizedFormMinorTotals(handedOff, 8, USD).gapMinor).toBe(0)

    // Items win raises the amount to the items sum instead.
    await user.click(itemsRadio())
    expect(lastHandoffItems()).toHaveLength(2)
    expect(lastHandoffAmountMinor()).toBe(850)
  })

  it('shows no notice without scanned items', () => {
    renderPreview(receiptDraft([], 1000))

    expect(screen.queryByText(/difference/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('resets to the receipt total when a new scan result arrives', async () => {
    const view = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 505),
    )
    await view.user.click(itemsRadio())
    expect(itemsRadio()).toBeChecked()

    // A fresh draft must never inherit the previous pick.
    await act(async () => {
      view.rerender(
        <AiExpensePreview
          open
          onOpenChange={() => undefined}
          group={group}
          currentLedgerParticipantId={null}
          draft={receiptDraft(
            [{ title: 'Apples', unitPrice: 2.5, quantity: 2 }],
            505,
          )}
        />,
      )
    })
    expect(totalRadio()).toBeChecked()
    expect(itemsRadio()).not.toBeChecked()
  })
})

describe('AiExpensePreview large gap', () => {
  it('offers the source-of-truth choice immediately, preselecting the receipt total', () => {
    // 2 × $2.50 = $5.00 scanned against a $10.00 total: far beyond the last
    // two minor-unit digits, so this is a mismatch, not rounding. Both
    // choices are available at once with the receipt total preselected.
    renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )

    expect(screen.getByText(/receipt total is/i)).toBeInTheDocument()
    expect(screen.getByText(/more than rounding/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /accept/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(totalRadio()).toBeChecked()
    expect(itemsRadio()).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()

    // The difference flows through as an "Other (unaccounted)" row — a
    // real item with a non-empty title, so it passes validation.
    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(2)
    expect(handedOff[1]).toEqual({
      title: 'Other (unaccounted)',
      unitPrice: 5,
      quantity: 1,
    })
    expect(lastHandoffAmountMinor()).toBe(1000)
    expect(getItemizedFormMinorTotals(handedOff, 10, USD).gapMinor).toBe(0)
    // The handoff must be submittable: real items require a non-empty
    // title (itemTitleRequired) and a non-zero price, unlike the
    // display-only filler row.
    for (const item of handedOff) {
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.unitPrice).not.toBe(0)
    }
  })

  it('rewrites the amount to the items total when items win', async () => {
    const { user } = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )

    await user.click(itemsRadio())

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(1)
    expect(lastHandoffAmountMinor()).toBe(500)
    expect(getItemizedFormMinorTotals(handedOff, 5, USD).gapMinor).toBe(0)
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()
  })

  it('names a large negative adjustment Other (excess)', async () => {
    // $13.50 of items against a $10.00 total: a −$3.50 gap.
    const { user } = renderPreview(
      receiptDraft(
        [
          { title: 'Apples', unitPrice: 2.5, quantity: 2 },
          { title: 'Bread', unitPrice: 3.5, quantity: 1 },
          { title: 'Cheese', unitPrice: 5, quantity: 1 },
        ],
        1000,
      ),
    )

    expect(totalRadio()).toBeChecked()
    expect(totalRadio()).toHaveAccessibleName(
      /subtract \$3\.50 as other \(excess\)/i,
    )

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(4)
    expect(handedOff[3]).toEqual({
      title: 'Other (excess)',
      unitPrice: -3.5,
      quantity: 1,
    })
    expect(getItemizedFormMinorTotals(handedOff, 10, USD).gapMinor).toBe(0)
    for (const item of handedOff) {
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.unitPrice).not.toBe(0)
    }

    // Items win raises the amount to the items sum instead.
    await user.click(itemsRadio())
    expect(lastHandoffItems()).toHaveLength(3)
    expect(lastHandoffAmountMinor()).toBe(1350)
  })

  it('resets to the receipt total when a new scan result arrives', async () => {
    const view = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )
    await view.user.click(itemsRadio())
    expect(itemsRadio()).toBeChecked()

    // A fresh draft must never inherit the previous pick.
    await act(async () => {
      view.rerender(
        <AiExpensePreview
          open
          onOpenChange={() => undefined}
          group={group}
          currentLedgerParticipantId={null}
          draft={receiptDraft(
            [{ title: 'Apples', unitPrice: 2.5, quantity: 2 }],
            1000,
          )}
        />,
      )
    })
    expect(totalRadio()).toBeChecked()
    expect(itemsRadio()).not.toBeChecked()
  })
})
