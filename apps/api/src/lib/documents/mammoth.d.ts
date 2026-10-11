/**
 * Minimal typings for the untyped `mammoth` dependency (no `@types/mammoth`
 * exists). Only the surface this codebase uses is declared.
 */
declare module 'mammoth' {
  export function extractRawText(input: {
    buffer: Uint8Array | Buffer
  }): Promise<{ value: string; messages: Array<{ type: string }> }>

  const mammoth: {
    extractRawText: typeof extractRawText
  }

  export default mammoth
}
