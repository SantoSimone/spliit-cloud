import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useCurrentGroup,
  useCurrentGroupOrNull,
} from '@/app/groups/[groupId]/current-group-context'
import { ReceiptScanTrigger } from '@/app/groups/[groupId]/expenses/create-from-receipt-button'
import {
  hasPwaUpdateBlockers,
  resetPwaUpdateBlockersForTests,
} from '@/lib/pwa-update-blockers'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'

const mockMutateAsync = vi.fn()
const mockToast = vi.fn()
const mockUploadToS3 = vi.fn()
const mockResizeImage = vi.fn()

vi.mock('@/app/groups/[groupId]/current-group-context', () => ({
  useCurrentGroup: vi.fn(),
  useCurrentGroupOrNull: vi.fn(),
  useIsReadOnlyGroupViewer: vi.fn().mockReturnValue(false),
}))

vi.mock('@/trpc/client', () => ({
  trpc: {
    ai: {
      extractExpenseInformationFromImage: {
        useMutation: () => ({ mutateAsync: mockMutateAsync }),
      },
    },
  },
}))

vi.mock('@/lib/upload', () => ({
  resizeImage: (...args: unknown[]) => mockResizeImage(...args),
  useExpenseDocumentUpload: () => ({
    uploadToS3: (...args: unknown[]) => mockUploadToS3(...args),
  }),
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({}),
}))

const group = {
  id: 'group-1',
  name: 'Trip',
  currency: '$',
  currencyCode: 'USD',
  ledgerId: 'ledger-1',
}

const documents = [
  {
    id: 'doc-1',
    url: 'https://example.com/receipt.jpg',
    width: 800,
    height: 600,
  },
]

const scanResult = {
  amount: 1000,
  categoryId: 'groceries',
  currencyCode: 'USD',
  date: '2025-01-01',
  title: 'Test Store',
  items: [],
  empty: false,
}

const emptyScanResult = {
  amount: Number.NaN,
  categoryId: null,
  currencyCode: null,
  date: null,
  title: null,
  items: [],
  empty: true,
}

function renderTrigger(
  props: Partial<React.ComponentProps<typeof ReceiptScanTrigger>> = {},
) {
  return render(
    <ReceiptScanTrigger documents={documents} autoScan {...props} />,
  )
}

beforeEach(() => {
  vi.mocked(useCurrentGroup).mockReturnValue({
    group,
    isLoading: false,
  } as never)
  vi.mocked(useCurrentGroupOrNull).mockReturnValue({
    group,
    groupId: group.id,
    isLoading: false,
  } as never)
  mockMutateAsync.mockReset()
  mockMutateAsync.mockResolvedValue(scanResult)
  mockToast.mockReset()
  mockUploadToS3.mockReset()
  mockResizeImage.mockReset()
  localStorage.clear()
})

async function openDialog() {
  const result = renderTrigger()
  const trigger = screen.getByRole('button', { name: /ai receipt scan/i })
  await result.user.click(trigger)
  return result
}

async function waitForSettledCheckbox() {
  const checkbox = await screen.findByRole('checkbox', { name: /translate/i })
  await waitFor(() => {
    expect(checkbox).toBeEnabled()
  })
  return checkbox
}

describe('ReceiptScanTrigger translate checkbox', () => {
  it('uses one full-width scan control with a mobile-only camera segment', async () => {
    const { user } = renderTrigger({ documents: [], autoScan: false })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    const scanButton = screen.getByRole('button', { name: 'Scan receipt' })
    const cameraButton = screen.getByRole('button', { name: 'Take photo' })
    expect(scanButton).toHaveClass('flex-1')
    expect(cameraButton).toHaveClass('sm:hidden')
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.textContent?.includes('Scan receipt')),
    ).toHaveLength(1)

    const [fileInput, cameraInput] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    )
    const fileClick = vi.spyOn(fileInput!, 'click')
    const cameraClick = vi.spyOn(cameraInput!, 'click')
    await user.click(scanButton)
    expect(fileClick).toHaveBeenCalledOnce()
    await user.click(cameraButton)
    expect(cameraClick).toHaveBeenCalledOnce()

    expect(cameraInput).toHaveAttribute('accept', 'image/*')
    expect(cameraInput).toHaveAttribute('capture', 'environment')
  })

  it('rejects a multi-image drop instead of silently choosing one', async () => {
    const { user } = renderTrigger({ documents: [], autoScan: false })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]:not([capture])',
    )!
    fireEvent.change(input, {
      target: {
        files: [
          new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
          new File(['two'], 'two.jpg', { type: 'image/jpeg' }),
        ],
      },
    })

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    expect(mockMutateAsync).not.toHaveBeenCalled()
  })

  it('is unchecked by default and sends translateToLocale: false', async () => {
    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    expect(mockMutateAsync.mock.calls[0][0].translateToLocale).toBe(false)

    const checkbox = await waitForSettledCheckbox()
    expect(checkbox).not.toBeChecked()
  })

  it('reads stored "true" and sends translateToLocale: true on auto-scan', async () => {
    localStorage.setItem('spliit-receipt-translate-to-locale', 'true')

    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    expect(mockMutateAsync.mock.calls[0][0].translateToLocale).toBe(true)

    const checkbox = await waitForSettledCheckbox()
    expect(checkbox).toBeChecked()
  })

  it('persists the checkbox value to localStorage on toggle', async () => {
    const { user } = await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    const checkbox = await waitForSettledCheckbox()
    await user.click(checkbox)

    expect(localStorage.getItem('spliit-receipt-translate-to-locale')).toBe(
      'true',
    )
  })

  it('rescans with the new value when toggled after a completed scan', async () => {
    const { user } = await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    const checkbox = await waitForSettledCheckbox()
    await user.click(checkbox)

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(2)
    })

    expect(mockMutateAsync.mock.calls[1][0].translateToLocale).toBe(true)
    expect(mockMutateAsync.mock.calls[1][0].documentUrl).toBe(documents[0].url)
  })

  it('is disabled while a scan is pending', async () => {
    let resolveScan: (value: unknown) => void
    mockMutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        }),
    )

    await openDialog()

    const checkbox = await screen.findByRole('checkbox', { name: /translate/i })
    expect(checkbox).toHaveAttribute('aria-disabled', 'true')

    await act(async () => {
      resolveScan!(scanResult)
    })

    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: /translate/i }),
      ).not.toHaveAttribute('aria-disabled', 'true')
    })
  })

  it('does not break when localStorage.getItem throws', async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation((key) => {
        if (key === 'spliit-receipt-translate-to-locale') {
          throw new Error('storage unavailable')
        }
        return null
      })

    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    expect(mockMutateAsync.mock.calls[0][0].translateToLocale).toBe(false)
    const checkbox = await waitForSettledCheckbox()
    expect(checkbox).not.toBeChecked()

    getItemSpy.mockRestore()
  })

  it('does not break when localStorage.setItem throws on toggle', async () => {
    const { user } = await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage unavailable')
      })

    const checkbox = await waitForSettledCheckbox()
    await user.click(checkbox)

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(2)
    })

    setItemSpy.mockRestore()
  })

  it('does not auto-rescan when toggling after a failed scan; Retry sends latest translation', async () => {
    let rejectScan: (err: unknown) => void
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject
        }),
    )
    mockMutateAsync.mockResolvedValue(scanResult)

    const { user } = await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    // Fail the first scan → selectedDocument is set, receiptInfo stays null,
    // and a destructive Retry toast is registered.
    await act(async () => {
      rejectScan!(new Error('AI service unavailable'))
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalled()
    })

    const toastCall = mockToast.mock.calls.at(-1)!
    const retryAction = toastCall[0].action as React.ReactElement<{
      onClick: () => void
    }>

    expect(retryAction).toBeTruthy()
    expect(mockMutateAsync).toHaveBeenCalledTimes(1)

    // Toggling the checkbox after a failed scan must NOT trigger another request.
    const checkbox = await waitForSettledCheckbox()
    await user.click(checkbox)

    // Give any rogue effect a chance to fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mockMutateAsync).toHaveBeenCalledTimes(1)

    // Invoking the Retry action must send the latest translateToLocale value.
    act(() => {
      retryAction.props.onClick()
    })

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(2)
      expect(checkbox).toBeEnabled()
    })

    expect(mockMutateAsync.mock.calls[1][0].translateToLocale).toBe(true)
    expect(mockMutateAsync.mock.calls[1][0].documentUrl).toBe(documents[0].url)
  })

  it('shows the timeout toast when the scan fails with a TIMEOUT error', async () => {
    let rejectScan: (err: unknown) => void
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject
        }),
    )

    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      rejectScan!({
        data: { code: 'TIMEOUT' },
        message: 'Receipt scanning failed due to timeout after 120s',
      })
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalled()
    })

    const toastCall = mockToast.mock.calls.at(-1)!
    expect(toastCall[0].title).toBe('Receipt scanning timed out')
    expect(toastCall[0].description).toContain(
      'Receipt scanning failed due to timeout',
    )
    expect(toastCall[0].variant).toBe('destructive')
    // The timeout toast keeps the same Retry action as generic failures.
    expect(toastCall[0].action).toBeTruthy()

    // The dialog settles instead of hanging on the spinner.
    await waitForSettledCheckbox()
  })

  it('shows the generic error toast for non-timeout scan failures', async () => {
    let rejectScan: (err: unknown) => void
    mockMutateAsync.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectScan = reject
        }),
    )

    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      rejectScan!(new Error('AI service unavailable'))
    })

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalled()
    })

    const toastCall = mockToast.mock.calls.at(-1)!
    expect(toastCall[0].title).not.toBe('Receipt scanning timed out')
  })
})

describe('ReceiptScanTrigger document uploads', () => {
  function fileInput() {
    return document.querySelector<HTMLInputElement>(
      'input[type="file"]:not([capture])',
    )!
  }

  it('uploads PDFs as-is and scans them by document reference', async () => {
    mockUploadToS3.mockResolvedValue({
      url: 'https://example.com/invoice.pdf',
    })
    const { user } = renderTrigger({ documents: [], autoScan: false })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    const pdf = new File(['%PDF-1.4'], 'invoice.pdf', {
      type: 'application/pdf',
    })
    fireEvent.change(fileInput(), { target: { files: [pdf] } })

    await waitFor(() => {
      expect(mockUploadToS3).toHaveBeenCalledTimes(1)
    })
    // Documents skip the image resize path entirely.
    expect(mockResizeImage).not.toHaveBeenCalled()
    expect(mockUploadToS3.mock.calls[0][0]).toBe(pdf)

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })
    expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
      documentUrl: 'https://example.com/invoice.pdf',
      contentType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
    // A file card (not an <img>) previews the selected document.
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument()
  })

  it('rejects attachable-but-unscannable files with the AI toast', async () => {
    const { user } = renderTrigger({ documents: [], autoScan: false })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    fireEvent.change(fileInput(), {
      target: {
        files: [
          new File(['legacy'], 'legacy.doc', { type: 'application/msword' }),
        ],
      },
    })

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    expect(mockMutateAsync).not.toHaveBeenCalled()
    expect(mockUploadToS3).not.toHaveBeenCalled()
  })

  it('lists attached PDFs for scanning and sends their reference on click', async () => {
    const pdfDocuments = [
      {
        id: 'doc-pdf',
        url: 'https://example.com/invoice.pdf',
        width: null,
        height: null,
        fileName: 'invoice.pdf',
        contentType: 'application/pdf',
      },
    ]
    const { user } = renderTrigger({
      documents: pdfDocuments,
      autoScan: false,
    })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    await user.click(
      await screen.findByRole('button', { name: /invoice\.pdf/i }),
    )

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })
    expect(mockMutateAsync.mock.calls[0][0]).toMatchObject({
      documentUrl: 'https://example.com/invoice.pdf',
      contentType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
  })
})

describe('ReceiptScanTrigger update protection', () => {
  beforeEach(() => {
    resetPwaUpdateBlockersForTests()
  })

  it('holds protection while the scanned result awaits acceptance', async () => {
    await openDialog()

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    // The scan finished (checkbox re-enabled) but the dialog still holds the
    // selected document + AI result: an update must not reload under it.
    await waitForSettledCheckbox()
    expect(hasPwaUpdateBlockers()).toBe(true)

    resetPwaUpdateBlockersForTests()
  })
})

describe('ReceiptScanTrigger stored-unit conversion', () => {
  it('converts API minor/milli units to major display units once', async () => {
    mockMutateAsync.mockResolvedValue({
      ...scanResult,
      items: [{ title: 'Milk', unitPrice: 4700, quantity: 2000 }],
    })
    const onAccept = vi.fn()
    const { user } = renderTrigger({
      mode: 'create',
      directAccept: true,
      onAccept,
    })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    await waitFor(() => {
      expect(onAccept).toHaveBeenCalledTimes(1)
    })
    expect(onAccept.mock.calls[0][0].info.items).toEqual([
      { title: 'Milk', unitPrice: 47, quantity: 2 },
    ])
    expect(onAccept.mock.calls[0][0].info.amount).toBe(1000)
  })
})

describe('ReceiptScanTrigger empty results', () => {
  it('shows the empty notice instead of auto-accepting with directAccept', async () => {
    mockMutateAsync.mockResolvedValue(emptyScanResult)
    const onAccept = vi.fn()
    const { user } = renderTrigger({
      mode: 'create',
      directAccept: true,
      onAccept,
    })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })

    // The notice is explicit, and the preview handoff does not fire: the
    // user stays in the dialog with the photo attached.
    expect(
      await screen.findByText(/no expense details could be read/i),
    ).toBeInTheDocument()
    await waitForSettledCheckbox()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('still offers Continue for manual entry after an empty scan', async () => {
    mockMutateAsync.mockResolvedValue(emptyScanResult)
    const onAccept = vi.fn()
    const { user } = renderTrigger({ onAccept })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1)
    })
    expect(
      await screen.findByText(/no expense details could be read/i),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept.mock.calls[0][0].info.empty).toBe(true)
    expect(onAccept.mock.calls[0][0].document.url).toBe(documents[0].url)
  })

  it('auto-accepts non-empty scans with directAccept', async () => {
    const onAccept = vi.fn()
    const { user } = renderTrigger({
      mode: 'create',
      directAccept: true,
      onAccept,
    })
    await user.click(screen.getByRole('button', { name: /ai receipt scan/i }))

    await waitFor(() => {
      expect(onAccept).toHaveBeenCalledTimes(1)
    })
    expect(
      screen.queryByText(/no expense details could be read/i),
    ).not.toBeInTheDocument()
  })
})
