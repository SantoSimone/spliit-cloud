import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  Check,
  FileAudio,
  FileText,
  Pencil,
  Receipt,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AiReceiptItems } from '@/app/groups/[groupId]/expenses/ai-receipt-items'
import { CategoryIcon } from '@/app/groups/[groupId]/expenses/category-icon'
import Image from '@/components/app-image'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getCurrency } from '@/lib/currency'
import { usePwaUpdateBlocker } from '@/lib/pwa-update-blockers'
import { useIdempotentCreate } from '@/lib/use-idempotent-create'
import {
  formatCurrency,
  formatDateOnly,
  getCurrencyFromGroup,
} from '@/lib/utils'
import type { CreateExpenseSearch } from '@/router/schemas'
import {
  amountAsDecimal,
  amountAsMinorUnits,
  gapMinorAsMajor,
  getCategoryById,
  getItemizedFormMinorTotals,
  type CategoryId,
  type ExpenseFormInputValues,
} from '@spliit/domain'

import {
  buildExpenseFormDefaults,
  type GroupShape,
} from './expense-form/default-values'
import { buildSubmitValues } from './expense-form/submit-values'
import { useCreateExpenseMutation } from './expense-mutation-hooks'

export type AiExpenseDraft = {
  source: 'voice' | 'receipt'
  transcript?: string | null
  title: string | null
  /** Decimal major units for voice; minor units for receipt results. */
  amount: string | number | null
  amountUnit: 'major' | 'minor'
  currencyCode: string | null
  date: string | null
  categoryId: CategoryId | null
  payerParticipantId?: string | null
  participantIds?: string[]
  items?: Array<{ title: string; unitPrice: number; quantity: number }>
  document?: {
    id: string
    url: string
    width: number | null
    height: number | null
    fileName?: string | null
    contentType?: string | null
  }
  issues: Array<
    'missingTitle' | 'missingAmount' | 'invalidDate' | 'unsupportedCurrency'
  >
}

type AiExpensePreviewProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: GroupShape
  currentLedgerParticipantId: string | null | undefined
  draft: AiExpenseDraft
}

function parseDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T12:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function decimalAmount(
  value: string | number | null,
  unit: 'major' | 'minor',
  currency: ReturnType<typeof getCurrencyFromGroup>,
) {
  if (value == null) return null
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return null
  if (unit === 'major') return numberValue
  return amountAsDecimal(numberValue, currency)
}

export function AiExpensePreview({
  open,
  onOpenChange,
  group,
  currentLedgerParticipantId,
  draft,
}: AiExpensePreviewProps) {
  const { t } = useTranslation(undefined, { keyPrefix: 'AIExpense' })
  const { t: tForm } = useTranslation(undefined, { keyPrefix: 'ExpenseForm' })
  const { t: tPreview } = useTranslation(undefined, {
    keyPrefix: 'ExpensePreview',
  })
  const locale = useTranslation().i18n.language
  const { toast } = useToast()
  const createMutation = useCreateExpenseMutation()
  const createAttempt = useIdempotentCreate()
  // The draft holds an uploaded document + AI extraction that closing would
  // discard, and the create call itself must not be interrupted. This is also
  // the receipt/voice handoff target: the scan dialog unregisters as it
  // closes while this registers on open.
  usePwaUpdateBlocker(open, 'ai-expense-preview')
  const groupCurrency = getCurrencyFromGroup(group)
  const normalizedCurrencyCode =
    draft.currencyCode?.trim().toUpperCase() || null
  const inputCurrency = normalizedCurrencyCode
    ? (getCurrency(normalizedCurrencyCode) ?? groupCurrency)
    : groupCurrency
  const amountMajor = decimalAmount(
    draft.amount,
    draft.amountUnit,
    inputCurrency,
  )
  const amountMinor =
    amountMajor != null ? amountAsMinorUnits(amountMajor, inputCurrency) : null
  const category = draft.categoryId ? getCategoryById(draft.categoryId) : null
  const selectedParticipantIds = useMemo(
    () => new Set(draft.participantIds ?? []),
    [draft.participantIds],
  )
  const hasUnresolvedCurrency = Boolean(
    normalizedCurrencyCode && !getCurrency(normalizedCurrencyCode),
  )

  // Scanned line items rarely cover the receipt total exactly: the scan
  // prompt excludes taxes and service charges by design, and each line is
  // rounded to minor units independently at save time. Surface that minor-unit
  // gap (same helper as save serialization) and let the user absorb it with
  // an explicit "Rounding" row. The row stays hidden from the item list —
  // the checkbox below is its only UI — but it flows into the edit-form
  // handoff and quick-create values when checked.
  const baseItems = useMemo(() => draft.items ?? [], [draft.items])
  const baseTotals = useMemo(
    () =>
      baseItems.length > 0 && amountMajor != null
        ? getItemizedFormMinorTotals(baseItems, amountMajor, inputCurrency)
        : null,
    [amountMajor, baseItems, inputCurrency],
  )
  const gapMinor = baseTotals?.gapMinor ?? 0
  const hasItemsGap = baseTotals != null && gapMinor !== 0
  const roundingItemMajor =
    hasItemsGap && baseTotals != null
      ? gapMinorAsMajor(gapMinor, inputCurrency)
      : null
  // Rounding is pre-checked: most scans need it, and the balanced handoff is
  // the safer default. Unchecking surfaces an error instead of silently
  // creating an unbalanced expense.
  const [addRounding, setAddRounding] = useState(true)
  const [roundingDraft, setRoundingDraft] = useState(draft)
  if (roundingDraft !== draft) {
    // A new scan result must never inherit the previous choice: the
    // "Rounding" row is derived per draft, so reset during render
    // (React-endorsed previous-render comparison, not an effect) to avoid
    // cascading renders.
    setRoundingDraft(draft)
    setAddRounding(true)
  }
  const effectiveItems = useMemo(
    () =>
      hasItemsGap &&
      addRounding &&
      roundingItemMajor != null &&
      baseTotals != null
        ? [
            ...baseItems,
            {
              title: t('roundingItemTitle'),
              unitPrice: roundingItemMajor,
              quantity: 1,
            },
          ]
        : baseItems,
    [addRounding, baseItems, baseTotals, hasItemsGap, roundingItemMajor, t],
  )

  const searchParams = useMemo<CreateExpenseSearch>(() => {
    const params: CreateExpenseSearch = {}
    if (amountMinor != null) params.amount = String(amountMinor)
    if (draft.title) params.title = draft.title
    if (normalizedCurrencyCode) params.originalCurrency = normalizedCurrencyCode
    if (draft.date && parseDate(draft.date)) params.date = draft.date
    if (draft.categoryId) params.categoryId = draft.categoryId
    if (draft.payerParticipantId) params.payer = draft.payerParticipantId
    if (selectedParticipantIds.size > 0) {
      params.participants = [...selectedParticipantIds].join(',')
    }
    if (effectiveItems.length) params.items = JSON.stringify(effectiveItems)
    if (draft.document) {
      params.imageUrl = draft.document.url
      if (draft.document.width != null) {
        params.imageWidth = String(draft.document.width)
      }
      if (draft.document.height != null) {
        params.imageHeight = String(draft.document.height)
      }
      if (draft.document.fileName) {
        params.fileName = draft.document.fileName
      }
      if (draft.document.contentType) {
        params.contentType = draft.document.contentType
      }
    }
    return params
  }, [
    amountMinor,
    draft,
    effectiveItems,
    normalizedCurrencyCode,
    selectedParticipantIds,
  ])

  const formValues = useMemo<ExpenseFormInputValues>(() => {
    const defaults = buildExpenseFormDefaults({
      isCreate: true,
      searchParams,
      group,
      groupCurrency,
      currentLedgerParticipantId,
      settlementTitle: tForm('settlementTitle'),
      today: new Date(),
    })
    const next = { ...defaults }
    if (draft.payerParticipantId && amountMajor != null) {
      next.paidBySplitMode = 'BY_AMOUNT'
      next.paidByList = [
        { participant: draft.payerParticipantId, shares: amountMajor },
      ]
    }
    if (selectedParticipantIds.size > 0) {
      next.splitMode = 'EVENLY'
      next.paidFor = [...selectedParticipantIds].map((participant) => ({
        participant,
        shares: 1,
      }))
    }
    return next
  }, [
    amountMajor,
    currentLedgerParticipantId,
    draft.payerParticipantId,
    group,
    groupCurrency,
    searchParams,
    selectedParticipantIds,
    tForm,
  ])

  const canCreate = Boolean(
    formValues &&
    draft.title?.trim() &&
    amountMinor != null &&
    amountMinor > 0 &&
    !hasUnresolvedCurrency &&
    draft.issues.length === 0 &&
    // An unchecked rounding gap would fail itemized validation on save:
    // force the manual-edit path instead of one-click creating a broken
    // expense.
    !(hasItemsGap && !addRounding),
  )

  const navigateToForm = () => {
    onOpenChange(false)
  }

  const handleCreate = async () => {
    if (!formValues || !canCreate) return
    try {
      const expense = buildSubmitValues(formValues, {
        groupCurrency,
        conversionRequired: Boolean(
          formValues.originalCurrency &&
          formValues.originalCurrency !== group.currencyCode,
        ),
      })
      const created = await createAttempt.run((requestId) =>
        createMutation.mutateAsync({ groupId: group.id, requestId, expense }),
      )
      if (created === null) return
      toast({ description: t('created'), variant: 'success' })
      onOpenChange(false)
    } catch (error) {
      toast({
        description: error instanceof Error ? error.message : t('createError'),
        variant: 'destructive',
      })
    }
  }

  const icon = draft.source === 'voice' ? FileAudio : Receipt
  const SourceIcon = icon
  const title = draft.title ?? t('missing')
  const displayCurrency = normalizedCurrencyCode
    ? (getCurrency(normalizedCurrencyCode) ?? groupCurrency)
    : groupCurrency

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              <SourceIcon className="size-5" />
            </span>
            <span>{t('title')}</span>
            <Badge variant="secondary">AI</Badge>
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('description')}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="max-h-[70vh] space-y-4 overflow-y-auto">
          {draft.transcript && (
            <div className="rounded-lg border bg-muted/25 p-3 text-sm text-muted-foreground italic">
              “{draft.transcript}”
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 rounded-lg border p-4 text-sm">
            <div className="col-span-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t('group')}
              </div>
              <div className="font-medium">{group.name}</div>
            </div>
            <div className="col-span-2">
              <div className="text-xs font-medium text-muted-foreground">
                {t('expenseTitle')}
              </div>
              <div>{title}</div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('amount')}
              </div>
              <div>
                {amountMinor != null
                  ? formatCurrency(displayCurrency, amountMinor, locale)
                  : t('missing')}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('date')}
              </div>
              <div>
                {parseDate(draft.date)
                  ? formatDateOnly(parseDate(draft.date)!, locale, {
                      dateStyle: 'medium',
                    })
                  : t('defaultDate')}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('category')}
              </div>
              <div className="inline-flex items-center gap-1">
                {category && (
                  <CategoryIcon category={category} className="size-4" />
                )}
                {category?.name ?? t('defaultCategory')}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                {t('split')}
              </div>
              <div>
                {selectedParticipantIds.size > 0
                  ? t('namedParticipants', {
                      count: selectedParticipantIds.size,
                    })
                  : t('defaultSplit')}
              </div>
            </div>
            {draft.payerParticipantId && (
              <div className="col-span-2 border-t pt-3">
                <div className="text-xs font-medium text-muted-foreground">
                  {tPreview('paidBy')}
                </div>
                <div>
                  {group.participants.find(
                    (participant) =>
                      participant.id === draft.payerParticipantId,
                  )?.name ?? t('missing')}
                </div>
              </div>
            )}
            {baseItems.length ? (
              <div className="col-span-2 border-t pt-3">
                <AiReceiptItems
                  items={baseItems}
                  currency={displayCurrency}
                  locale={locale}
                  heading={t('items')}
                />
                {hasItemsGap &&
                baseTotals != null &&
                roundingItemMajor != null ? (
                  <div
                    className={
                      addRounding
                        ? 'mt-2 rounded-lg border border-amber-300/60 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-950/20'
                        : 'mt-2 rounded-lg border border-destructive/60 bg-destructive/10 p-3'
                    }
                  >
                    <p
                      className={
                        addRounding
                          ? 'text-sm text-amber-900 dark:text-amber-200'
                          : 'text-sm text-destructive'
                      }
                    >
                      {t('itemsGapMismatch', {
                        items: formatCurrency(
                          displayCurrency,
                          baseTotals.itemsMinor,
                          locale,
                        ),
                        total: formatCurrency(
                          displayCurrency,
                          baseTotals.amountMinor,
                          locale,
                        ),
                        gap: formatCurrency(displayCurrency, gapMinor, locale),
                      })}
                    </p>
                    {!addRounding ? (
                      <p role="alert" className="mt-1 text-sm text-destructive">
                        {t('roundingRequiredError')}
                      </p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      <Checkbox
                        id="ai-expense-add-rounding"
                        checked={addRounding}
                        onCheckedChange={(checked) =>
                          setAddRounding(checked === true)
                        }
                      />
                      <Label
                        htmlFor="ai-expense-add-rounding"
                        className={
                          addRounding
                            ? 'cursor-pointer font-normal text-amber-900 dark:text-amber-200'
                            : 'cursor-pointer font-normal text-destructive'
                        }
                      >
                        {t(
                          gapMinor < 0
                            ? 'subtractRoundingAsItem'
                            : 'addRoundingAsItem',
                          {
                            // The credit case (items exceed the total) reads
                            // as "Subtract $0.50 rounding", not "Add -$0.50…".
                            amount: formatCurrency(
                              displayCurrency,
                              Math.abs(gapMinor),
                              locale,
                            ),
                          },
                        )}
                      </Label>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {draft.document && (
              <div className="col-span-2 border-t pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {tPreview('attachments', { count: 1 })}
                </div>
                {draft.document.width != null &&
                draft.document.height != null ? (
                  <Image
                    src={draft.document.url}
                    alt={tPreview('attachments', { count: 1 })}
                    width={draft.document.width}
                    height={draft.document.height}
                    className="max-h-56 w-full rounded-md border object-contain"
                  />
                ) : (
                  <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
                    <FileText className="h-8 w-8 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {draft.document.fileName ??
                        tPreview('attachments', { count: 1 })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          {draft.issues.length > 0 && (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4" />
                {t('checkDetails')}
              </div>
              <ul className="list-disc space-y-1 ps-5">
                {draft.issues.map((issue) => (
                  <li key={issue}>{t(`issues.${issue}`)}</li>
                ))}
              </ul>
            </div>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="flex-row gap-2 sm:justify-end">
          <Button
            variant={canCreate ? 'outline' : 'default'}
            className="flex-1 sm:flex-none"
            nativeButton={false}
            render={
              <Link
                to="/groups/$groupId/expenses/create"
                params={{ groupId: group.id }}
                search={searchParams}
              />
            }
            onClick={navigateToForm}
          >
            <Pencil className="me-2 size-4" />
            {canCreate ? t('edit') : t('completeDetails')}
          </Button>
          {canCreate && (
            <Button
              type="button"
              className="flex-1 sm:flex-none"
              disabled={createMutation.isPending}
              onClick={() => void handleCreate()}
            >
              <Check className="me-2 size-4" />
              {createMutation.isPending ? t('creating') : t('create')}
            </Button>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
