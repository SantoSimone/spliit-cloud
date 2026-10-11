import { describe, expect, it } from 'vitest'

import { classifyDocument } from './classify'

describe('classifyDocument', () => {
  it.each([
    ['image/jpeg', 'receipt.jpg'],
    ['image/png', 'receipt.png'],
    ['image/webp', 'receipt.webp'],
    ['image/heic', 'photo.heic'],
    ['image/heif', 'photo.heif'],
  ])('routes %s to the image flow', (contentType, fileName) => {
    expect(classifyDocument({ contentType, fileName })).toBe('image')
  })

  it('routes image extensions with a generic content type to the image flow', () => {
    expect(
      classifyDocument({
        contentType: 'application/octet-stream',
        fileName: 'IMG_1234.heic',
      }),
    ).toBe('image')
    expect(classifyDocument({ contentType: null, fileName: 'scan.PNG' })).toBe(
      'image',
    )
  })

  it.each([
    ['application/pdf', 'invoice.pdf'],
    ['application/pdf; charset=binary', 'invoice.PDF'],
  ])('routes %s to the pdf flow', (contentType, fileName) => {
    expect(classifyDocument({ contentType, fileName })).toBe('pdf')
  })

  it('routes pdf extensions with a generic content type to the pdf flow', () => {
    expect(
      classifyDocument({
        contentType: 'application/octet-stream',
        fileName: 'invoice.pdf',
      }),
    ).toBe('pdf')
  })

  it.each([
    ['text/plain', 'notes.txt'],
    ['text/csv', 'export.csv'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'invoice.docx',
    ],
    ['application/vnd.oasis.opendocument.text', 'letter.odt'],
  ])('routes %s to the text-document flow', (contentType, fileName) => {
    expect(classifyDocument({ contentType, fileName })).toBe('text-document')
  })

  it('routes text extensions with a generic content type to text documents', () => {
    expect(
      classifyDocument({
        contentType: 'application/octet-stream',
        fileName: 'notes.TXT',
      }),
    ).toBe('text-document')
    expect(classifyDocument({ contentType: null, fileName: 'bill.docx' })).toBe(
      'text-document',
    )
  })

  it.each([
    ['application/msword', 'legacy.doc'],
    ['application/vnd.ms-excel', 'sheet.xls'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'sheet.xlsx',
    ],
    ['text/html', 'page.html'],
    ['application/zip', 'archive.zip'],
  ])('marks %s as unsupported', (contentType, fileName) => {
    expect(classifyDocument({ contentType, fileName })).toBe('unsupported')
  })

  it('marks extensionless unknown types as unsupported', () => {
    expect(classifyDocument({ contentType: null, fileName: 'receipt' })).toBe(
      'unsupported',
    )
  })
})
