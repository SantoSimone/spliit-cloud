import { AiReceiptItems } from '@/app/groups/[groupId]/expenses/ai-receipt-items'
import { render, screen } from '@/test/test-utils'

const USD = { code: 'USD', symbol: '$', decimal_digits: 2, rounding: 0 }

const fourItems = [
  { title: 'Milk', unitPrice: 2.5, quantity: 1 },
  { title: 'Bread', unitPrice: 1.2, quantity: 2 },
  { title: 'Eggs', unitPrice: 3, quantity: 1 },
  { title: 'Butter', unitPrice: 4.5, quantity: 1 },
]

describe('AiReceiptItems', () => {
  it('renders titles with line totals instead of a comma-joined string', () => {
    render(
      <AiReceiptItems
        items={fourItems.slice(0, 2)}
        currency={USD}
        locale="en-US"
        heading="Items"
      />,
    )

    expect(screen.getByText('Milk')).toBeInTheDocument()
    expect(screen.getByText('Bread')).toBeInTheDocument()
    // $2.50 and 2 × $1.20 = $2.40 line totals (major-unit unit prices).
    expect(screen.getByText('$2.50')).toBeInTheDocument()
    expect(screen.getByText('$2.40')).toBeInTheDocument()
    // Quantity is only shown when it differs from 1; singles stay clean.
    expect(screen.queryByText('1 × $2.50')).not.toBeInTheDocument()
    expect(screen.getByText('2 × $1.20')).toBeInTheDocument()
    // Table-like structure: rows are list items separated by dividers.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('hides overflow items until the more control is pressed', async () => {
    const { user } = render(
      <AiReceiptItems
        items={fourItems}
        currency={USD}
        locale="en-US"
        heading="Items"
      />,
    )

    expect(screen.getByText('Milk')).toBeInTheDocument()
    expect(screen.queryByText('Butter')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /\+1 more/i }))

    expect(screen.getByText('Butter')).toBeInTheDocument()
  })

  it('renders nothing for an empty item list', () => {
    const { container } = render(
      <AiReceiptItems
        items={[]}
        currency={USD}
        locale="en-US"
        heading="Items"
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('localizes the quantity decimal separator', () => {
    render(
      <AiReceiptItems
        items={[{ title: 'Cheese', unitPrice: 2.5, quantity: 1.5 }]}
        currency={USD}
        locale="de-DE"
        heading="Items"
      />,
    )

    expect(screen.getByText(/1,5 ×/)).toBeInTheDocument()
  })
})
