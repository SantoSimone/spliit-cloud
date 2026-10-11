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

beforeEach(() => {
  linkSearches.length = 0
})

describe('AiExpensePreview rounding gap', () => {
  it('pre-checks rounding and hides the row: only the checkbox is visible', () => {
    // 2 × $2.50 = $5.00 scanned against a $10.00 total: a +$5.00 gap the
    // rounding row absorbs by default.
    renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )

    expect(screen.getByText(/difference/i)).toBeInTheDocument()
    const checkbox = screen.getByRole('checkbox', { name: /rounding/i })
    expect(checkbox).toBeChecked()
    expect(checkbox).toHaveAccessibleName('Add $5.00 rounding')
    // The rounding row flows into the handoff but never renders as a list
    // row: the checkbox is its only UI.
    expect(screen.queryByText('Rounding')).not.toBeInTheDocument()
    expect(screen.getByText('Apples')).toBeInTheDocument()

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(2)
    expect(handedOff[1]).toEqual({
      title: 'Rounding',
      unitPrice: 5,
      quantity: 1,
    })
    expect(getItemizedFormMinorTotals(handedOff, 10, USD).gapMinor).toBe(0)
  })

  it('shows an error and blocks quick-create when rounding is unchecked', async () => {
    const { user } = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )

    await user.click(screen.getByRole('checkbox', { name: /rounding/i }))

    // Error copy directs the user to re-accept rounding or edit manually.
    expect(screen.getByRole('alert')).toHaveTextContent(/must add up/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/edit.*manually/i)
    // The unbalanced handoff still flows to the edit form for manual fix…
    expect(lastHandoffItems()).toHaveLength(1)
    // …but one-click create is gone: only the manual-edit handoff remains
    // (the mocked edit link carries the unbalanced items to the form).
    expect(
      screen.queryByRole('button', { name: /create expense/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('edit-link')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /rounding/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /create expense/i }),
    ).toBeInTheDocument()
    expect(lastHandoffItems()).toHaveLength(2)
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
    expect(
      screen.queryByRole('checkbox', { name: /rounding/i }),
    ).not.toBeInTheDocument()
  })

  it('offers a signed rounding row when items exceed the total', () => {
    renderPreview(
      receiptDraft(
        [
          { title: 'Apples', unitPrice: 2.5, quantity: 2 },
          { title: 'Bread', unitPrice: 3.5, quantity: 1 },
        ],
        800,
      ),
    )

    // $8.50 of items against an $8.00 total: a −$0.50 rounding credit,
    // pre-checked and hidden from the list. The label reads "Subtract …",
    // never "Add -$0.50 …".
    const checkbox = screen.getByRole('checkbox', { name: /rounding/i })
    expect(checkbox).toBeChecked()
    expect(checkbox).toHaveAccessibleName('Subtract $0.50 rounding')
    expect(screen.queryByText('Rounding')).not.toBeInTheDocument()

    const handedOff = lastHandoffItems()
    expect(handedOff).toHaveLength(3)
    expect(handedOff[2]).toEqual({
      title: 'Rounding',
      unitPrice: -0.5,
      quantity: 1,
    })
    expect(getItemizedFormMinorTotals(handedOff, 8, USD).gapMinor).toBe(0)
  })

  it('shows no notice without scanned items', () => {
    renderPreview(receiptDraft([], 1000))

    expect(screen.queryByText(/difference/i)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: /rounding/i }),
    ).not.toBeInTheDocument()
  })

  it('resets to pre-checked when a new scan result arrives', async () => {
    const view = renderPreview(
      receiptDraft([{ title: 'Apples', unitPrice: 2.5, quantity: 2 }], 1000),
    )
    await view.user.click(screen.getByRole('checkbox', { name: /rounding/i }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // A fresh draft must never inherit the previous uncheck.
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
    expect(screen.getByRole('checkbox', { name: /rounding/i })).toBeChecked()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
