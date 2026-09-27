// Google Workspace tenant keys of the published Chat app's customer rows (google-chat-integration.md §10.3).

/** The ids one customer row knows, stored bare in its public `platformConfig`. */
export interface GoogleChatTenant {
  /** From a Space's `customer` (`customers/{customerId}`). */
  customerId?: string
  /** From Workspace users' `domainId`s (`domains/{domainId}`); a customer may own several domains. */
  domainIds?: string[]
}

/** The 409 copy when another organization holds the customer; it names no organization. */
export const GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE =
  'This Google Workspace organization is already connected to another AgentConnect organization.'

/** A bare Workspace customer or domain id. */
const BARE_ID = /^[A-Za-z0-9_-]{1,128}$/
const CUSTOMER_KEY = /^customers\/([A-Za-z0-9_-]{1,128})$/
const DOMAIN_KEY = /^domains\/([A-Za-z0-9_-]{1,128})$/

/** The customer id and the domain set a row's `platformConfig` carries; `domainIds` is comma-joined because the bag holds strings. */
export function googleChatTenantOf(config: Record<string, unknown> | null | undefined): GoogleChatTenant {
  const customerId = config?.customerId
  const joined = config?.domainIds
  const domainIds = typeof joined === 'string' ? [...new Set(joined.split(',').filter((id) => BARE_ID.test(id)))] : []
  return {
    ...(typeof customerId === 'string' && BARE_ID.test(customerId) ? { customerId } : {}),
    ...(domainIds.length > 0 ? { domainIds } : {})
  }
}

/** Every tenant key the ids name, `customers/…` first, then one `domains/…` per domain. */
export function googleChatTenantKeys(tenant: GoogleChatTenant): string[] {
  return [
    ...(tenant.customerId ? [`customers/${tenant.customerId}`] : []),
    ...(tenant.domainIds ?? []).map((id) => `domains/${id}`)
  ]
}

/** A row's primary key: `customers/…` when known, else its first `domains/…`; undefined for a tenantless row. */
export function googleChatPrimaryTenant(tenant: GoogleChatTenant): string | undefined {
  return googleChatTenantKeys(tenant)[0]
}

/** The `platformConfig` entries for the ids, as strings. */
export function googleChatTenantEntries(tenant: GoogleChatTenant): Record<string, string> {
  return {
    ...(tenant.customerId ? { customerId: tenant.customerId } : {}),
    ...(tenant.domainIds?.length ? { domainIds: tenant.domainIds.join(',') } : {})
  }
}

/** What a single-tenant row records from a tenant key its traffic named (§10.3): its first customer or a new domain; a second customer is refused. */
export function googleChatTenantLearning(
  current: Record<string, unknown> | null | undefined,
  key: string
): { kind: 'record'; entries: Record<string, string> } | { kind: 'known' } | { kind: 'refused'; reason: string } {
  const customerId = CUSTOMER_KEY.exec(key)?.[1]
  if (customerId) {
    const bound = googleChatTenantOf(current).customerId
    if (bound === undefined) return { kind: 'record', entries: { customerId } }
    return bound === customerId
      ? { kind: 'known' }
      : { kind: 'refused', reason: 'the row is bound to another customer' }
  }
  const domainId = DOMAIN_KEY.exec(key)?.[1]
  if (domainId) {
    const entries = googleChatDomainAdditions(current, [domainId])
    return Object.keys(entries).length > 0 ? { kind: 'record', entries } : { kind: 'known' }
  }
  return { kind: 'refused', reason: 'not a Workspace tenant key' }
}

/** The `domainIds` entry that appends every domain a row's current bag does not list yet; empty when it lists them all. */
export function googleChatDomainAdditions(
  current: Record<string, unknown> | null | undefined,
  domainIds: readonly string[]
): Record<string, string> {
  const known = googleChatTenantOf(current).domainIds ?? []
  const added = [...new Set(domainIds)].filter((id) => !known.includes(id))
  return added.length > 0 ? { domainIds: [...known, ...added].join(',') } : {}
}
