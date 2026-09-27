// Google Workspace tenant keys of the published Chat app's customer rows (google-chat-integration.md §10.3).

/** The ids one customer row knows, stored bare in its public `platformConfig`. */
export interface GoogleChatTenant {
  /** From a Space's `customer` (`customers/{customerId}`). */
  customerId?: string
  /** From a Workspace user's `domainId` (`domains/{domainId}`). */
  domainId?: string
}

/** The 409 copy when another organization holds the customer; it names no organization. */
export const GOOGLE_CHAT_CLAIM_TAKEN_MESSAGE =
  'This Google Workspace organization is already connected to another AgentConnect organization.'

/** The customer and domain ids a row's `platformConfig` carries. */
export function googleChatTenantOf(config: Record<string, unknown> | null | undefined): GoogleChatTenant {
  const customerId = config?.customerId
  const domainId = config?.domainId
  return {
    ...(typeof customerId === 'string' && customerId !== '' ? { customerId } : {}),
    ...(typeof domainId === 'string' && domainId !== '' ? { domainId } : {})
  }
}

/** Every tenant key the ids name, `customers/…` first. */
export function googleChatTenantKeys(tenant: GoogleChatTenant): string[] {
  return [
    ...(tenant.customerId ? [`customers/${tenant.customerId}`] : []),
    ...(tenant.domainId ? [`domains/${tenant.domainId}`] : [])
  ]
}

/** A row's primary key: `customers/…` when known, else `domains/…`; undefined for a tenantless row. */
export function googleChatPrimaryTenant(tenant: GoogleChatTenant): string | undefined {
  return googleChatTenantKeys(tenant)[0]
}

/** The `platformConfig` entries for the ids, as strings. */
export function googleChatTenantEntries(tenant: GoogleChatTenant): Record<string, string> {
  return {
    ...(tenant.customerId ? { customerId: tenant.customerId } : {}),
    ...(tenant.domainId ? { domainId: tenant.domainId } : {})
  }
}
