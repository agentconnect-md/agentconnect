/** DNS TXT lookup for domain verification (organization-sso.md §4.1). */
import { Resolver } from 'node:dns/promises'

/** The TXT values at `name`, empty when the name or the record type is absent; throws when the lookup itself fails. */
export type TxtLookup = (name: string) => Promise<string[]>

const ABSENT = new Set(['ENOTFOUND', 'ENODATA'])

export function systemTxtLookup(): TxtLookup {
  return async (name) => {
    const resolver = new Resolver({ timeout: 3000, tries: 2 })
    try {
      // A TXT value longer than 255 bytes arrives in chunks.
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''))
    } catch (err) {
      if (ABSENT.has((err as { code?: string }).code ?? '')) return []
      throw err
    }
  }
}
