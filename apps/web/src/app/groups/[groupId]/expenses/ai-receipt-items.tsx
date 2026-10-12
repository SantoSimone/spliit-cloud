import { useState } from 'react'

import type { Currency } from '@/lib/currency'
import { formatCurrency, formatNumber } from '@/lib/utils'
import { amountAsMinorUnits, lineAmountMinorFromMajor } from '@spliit/domain'

import { ExpenseItemsOverflowToggle } from './expense-items-overflow-toggle'
import { ReceiptItemRow, ReceiptItemsShell } from './receipt-items-shell'

export type AiReceiptItem = {
  title: string
  unitPrice: number
  quantity: number
}

/**
 * Receipt-item list sharing row styling with `ExpenseItemsSummary` (truncated
 * title left, tabular line total right, 3-row preview with overflow toggle) for
 * AI scan results, which carry `unitPrice × quantity` instead of stored line
 * amounts. Rows with a quantity other than 1 show a muted `qty × unit price`
 * sub-line; single-quantity rows stay clean.
 */
export function AiReceiptItems({
  items,
  currency,
  locale,
  heading,
}: {
  items: AiReceiptItem[]
  currency: Currency
  locale: string
  heading: string
}) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null

  const maxPreview = 3
  const remaining = items.length - maxPreview
  const visibleItems =
    expanded || remaining <= 0 ? items : items.slice(0, maxPreview)

  return (
    <ReceiptItemsShell
      heading={heading}
      footer={
        remaining > 0 ? (
          <ExpenseItemsOverflowToggle
            expanded={expanded}
            remaining={remaining}
            onToggle={() => setExpanded((open) => !open)}
          />
        ) : undefined
      }
    >
      {visibleItems.map((item, index) => (
        <ReceiptItemRow
          key={`${item.title}-${index}`}
          title={item.title}
          amount={formatCurrency(
            currency,
            lineAmountMinorFromMajor(
              amountAsMinorUnits(item.unitPrice, currency),
              item.quantity,
            ),
            locale,
          )}
          detail={
            item.quantity !== 1 ? (
              <div className="min-w-0 truncate text-xs leading-5 text-muted-foreground tabular-nums">
                {`${locale ? formatNumber(item.quantity, locale, { useGrouping: false }) : String(item.quantity)} × ${formatCurrency(currency, item.unitPrice, locale, true)}`}
              </div>
            ) : undefined
          }
        />
      ))}
    </ReceiptItemsShell>
  )
}
