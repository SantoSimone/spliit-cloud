import type { ReactNode } from 'react'

/**
 * Shared table-like receipt container for item lists (AI scan results and the
 * saved-expense view). Bordered card with light dividers between rows; row
 * content stays owned by each caller (line totals, qty sub-lines, assignees).
 */
export function ReceiptItemsShell({
  heading,
  children,
  footer,
}: {
  heading: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {heading}
      </h3>
      <div className="text-sm">
        <ul className="divide-y divide-border/70">{children}</ul>
        {footer ? (
          <div className="border-t border-border/70 pt-1">{footer}</div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Single receipt row: truncated title left, tabular line total right, optional
 * muted detail line (qty sub-line, assignees) underneath.
 */
export function ReceiptItemRow({
  title,
  amount,
  detail,
}: {
  title: ReactNode
  amount: ReactNode
  detail?: ReactNode
}) {
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="shrink-0 font-medium tabular-nums">{amount}</span>
      </div>
      {detail}
    </li>
  )
}
