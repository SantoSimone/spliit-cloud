import { describe, expect, it } from 'vitest'

import {
  migrateGroupExportManifestToV2,
  spliitAccountExportManifestSchema,
  spliitGroupExportManifestSchema,
  spliitGroupExportSnapshotSchema,
} from './export-manifest'

const minimalManifest = {
  format: 'spliit.cloud/export',
  version: 1,
  scope: { type: 'GROUP', sourceId: 'group-1' },
  exportedAt: '2026-08-10T12:00:00.000Z',
  complete: true,
  warnings: [],
  group: {
    sourceId: 'group-1',
    name: 'Trip',
    information: null,
    archived: false,
    groupType: 'GROUP',
    subgroupsEnabled: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    ledger: {
      sourceId: 'ledger-1',
      currency: '$',
      currencyCode: 'USD',
      createdAt: '2026-08-01T12:00:00.000Z',
    },
  },
  participants: [],
  subgroups: [],
  budgets: [],
  recurrenceSeries: [],
  expenses: [],
  orphanDocuments: [],
}

describe('spliitGroupExportManifestSchema', () => {
  it('accepts the versioned native group envelope', () => {
    expect(spliitGroupExportManifestSchema.parse(minimalManifest)).toEqual({
      ...minimalManifest,
      splitPresets: [],
    })
  })

  it('exposes the group data as a reusable container-independent snapshot', () => {
    const {
      format: _format,
      version: _version,
      scope: _scope,
      exportedAt: _exportedAt,
      ...snapshot
    } = minimalManifest

    expect(spliitGroupExportSnapshotSchema.parse(snapshot)).toEqual({
      ...snapshot,
      splitPresets: [],
    })
  })

  it('accepts versions 1 and 2 but rejects unsupported versions', () => {
    expect(
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        version: 1,
      }).version,
    ).toBe(1)
    expect(
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        version: 2,
      }).version,
    ).toBe(2)
    expect(() =>
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        version: 3,
      }),
    ).toThrow()

    expect(() =>
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        orphanDocuments: [
          {
            sourceId: 'doc-1',
            fileName: 'receipt.pdf',
            contentType: 'application/pdf',
            width: null,
            height: null,
            path: 'documents/_orphans/doc-1__receipt.pdf',
            status: 'INCLUDED',
            sizeBytes: 3,
            sha256: 'not-a-checksum',
          },
        ],
      }),
    ).toThrow()
  })

  it('accepts an account envelope with optional content sections', () => {
    expect(
      spliitAccountExportManifestSchema.parse({
        format: 'spliit.cloud/export',
        version: 1,
        scope: { type: 'ACCOUNT', sourceId: 'account-1' },
        exportedAt: '2026-08-10T12:00:00.000Z',
        complete: true,
        warnings: [],
        contents: {
          documents: false,
          accountPreferences: true,
          groupPreferences: false,
        },
        account: {
          sourceId: 'account-1',
          name: 'Alice',
          email: 'alice@example.com',
          preferences: {
            defaultCurrencyCode: 'EUR',
            timeZone: null,
            locale: null,
            theme: null,
            aiFeaturesEnabled: null,
            aiCategoryExtractEnabled: null,
            aiReceiptScanEnabled: null,
            aiVoiceExpenseEnabled: null,
          },
          notificationPreferences: [],
        },
        identities: [
          { sourceId: 'account-1', name: 'Alice', email: 'alice@example.com' },
        ],
        groups: [],
        groupPreferences: null,
      }),
    ).toMatchObject({ scope: { type: 'ACCOUNT' }, groups: [] })
  })

  it('accepts a legacy isReimbursement boolean on expenses and templates', () => {
    const expense = {
      sourceId: 'exp-1',
      createdAt: '2026-08-08T12:00:00.000Z',
      expenseDate: '2026-08-08T12:00:00.000Z',
      expenseTimeZone: 'UTC',
      title: 'Paid Alice',
      categoryId: 'payment',
      amount: 1000,
      originalAmount: null,
      originalCurrency: null,
      conversionRate: null,
      conversionSource: null,
      paidBySplitMode: 'EVENLY' as const,
      splitMode: 'EVENLY' as const,
      version: 1,
      createdByParticipantId: null,
      recurringSeriesId: null,
      recurrenceSequence: null,
      notes: null,
      paidByList: [],
      paidFor: [],
      items: [],
      itemizedRemainder: null,
      documents: [],
      comments: [],
      isReimbursement: true,
    }

    expect(
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        expenses: [expense],
      }),
    ).toMatchObject({
      expenses: [{ isReimbursement: true, categoryId: 'payment' }],
    })
  })

  it('allows an intentionally omitted document without a storage reference', () => {
    expect(
      spliitGroupExportManifestSchema.parse({
        ...minimalManifest,
        orphanDocuments: [
          {
            sourceId: 'doc-1',
            fileName: 'receipt.pdf',
            contentType: 'application/pdf',
            width: null,
            height: null,
            path: null,
            status: 'OMITTED',
            sizeBytes: null,
            sha256: null,
          },
        ],
      }),
    ).toMatchObject({ orphanDocuments: [{ status: 'OMITTED', path: null }] })
  })

  it('migrates v1 whole-unit quantities to v2 milli-units, leaving amounts untouched', () => {
    const parsed = spliitGroupExportManifestSchema.parse({
      ...minimalManifest,
      expenses: [
        {
          sourceId: 'exp-1',
          createdAt: '2026-08-08T12:00:00.000Z',
          expenseDate: '2026-08-08T12:00:00.000Z',
          expenseTimeZone: 'UTC',
          title: 'Produce',
          categoryId: 'groceries',
          amount: 500,
          originalAmount: null,
          originalCurrency: null,
          conversionRate: null,
          conversionSource: null,
          paidBySplitMode: 'EVENLY' as const,
          splitMode: 'ITEMIZED' as const,
          version: 1,
          createdByParticipantId: null,
          recurringSeriesId: null,
          recurrenceSequence: null,
          notes: null,
          paidByList: [],
          paidFor: [],
          items: [
            {
              sourceId: 'item-1',
              title: 'Apples',
              unitPrice: 250,
              // v1 whole units (fractional quantities did not exist yet).
              quantity: 2,
              amount: 500,
              splitMode: 'EVENLY' as const,
              paidFor: [],
              notes: null,
              createdAt: null,
            },
          ],
          itemizedRemainder: null,
          documents: [],
          comments: [],
        },
      ],
    })

    const migrated = migrateGroupExportManifestToV2(parsed)
    expect(migrated.version).toBe(2)
    // 2 whole units → 2000 milli-units; the $5.00 line amount is invariant.
    expect(migrated.expenses[0]?.items[0]).toMatchObject({
      quantity: 2000,
      amount: 500,
      unitPrice: 250,
    })

    // v2 manifests pass through unchanged.
    expect(migrateGroupExportManifestToV2(migrated)).toBe(migrated)
  })
})
