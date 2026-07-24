// Pure UI helpers for the connectors browser (open-connector integration). The
// catalog + connection APIs now live on the Control Plane (see lib/api.ts
// fetchConnectorCatalog / createConnectorConnection); this module is just the
// dependency-free rendering logic the ConnectorsModal shares. Provider shapes come
// from the CP DTOs.
import type { ConnectorAuthDefinition, ConnectorProviderDto } from '@/lib/api'

export interface CredentialField {
  key: string
  label: string
  inputType: 'text' | 'password' | 'textarea' | 'json'
  required: boolean
  secret: boolean
  placeholder?: string
  description?: string
}

/** The credential inputs to render for a chosen auth method (empty for oauth2 /
 *  no_auth — those have no user-entered fields here). Mirrors open-connector's
 *  credentialFieldsFor over the loosely-typed auth definition. */
export function credentialFieldsFor(auth: ConnectorAuthDefinition): CredentialField[] {
  if (auth.type === 'api_key') {
    const a = auth as { label?: string; placeholder?: string; description?: string; extraFields?: CredentialField[] }
    return [
      {
        key: 'apiKey',
        label: a.label ?? 'API key',
        inputType: 'password',
        required: true,
        secret: true,
        ...(a.placeholder ? { placeholder: a.placeholder } : {}),
        ...(a.description ? { description: a.description } : {})
      },
      ...(a.extraFields ?? [])
    ]
  }
  if (auth.type === 'custom_credential') return (auth as { fields?: CredentialField[] }).fields ?? []
  return []
}

/** The auth method to preselect: oauth2, else api_key, else the first. */
export function initialAuthType(provider: ConnectorProviderDto): ConnectorAuthDefinition['type'] | undefined {
  const oauth = provider.auth.find((a) => a.type === 'oauth2')
  return (oauth ?? provider.auth.find((a) => a.type === 'api_key') ?? provider.auth[0])?.type
}

/** Free-text search over name / service / categories / auth types. */
export function filterProviders(providers: ConnectorProviderDto[], query: string): ConnectorProviderDto[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return providers
  return providers.filter((p) =>
    [p.displayName, p.service, p.categories.join(' '), p.authTypes.join(' ')]
      .join(' ')
      .toLowerCase()
      .includes(normalized)
  )
}

/** Keep providers in `category` (or all when null). */
export function filterByCategory(providers: ConnectorProviderDto[], category: string | null): ConnectorProviderDto[] {
  if (!category) return providers
  return providers.filter((p) => p.categories.includes(category))
}

/** The distinct categories across the catalog, sorted, for the filter control. */
export function providerCategories(providers: ConnectorProviderDto[]): string[] {
  return [...new Set(providers.flatMap((p) => p.categories))].sort((a, b) => a.localeCompare(b))
}

export function providerInitials(displayName: string): string {
  return (
    displayName
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  )
}

/**
 * Icon URL for a provider. Only an ABSOLUTE http(s) iconUrl is used directly (a
 * relative one would resolve against the console origin, not open-connector, which
 * the browser can't reach); else a Google-favicon lookup from the homepage; else
 * null (→ initials).
 */
export function providerIconUrl(provider: ConnectorProviderDto): string | null {
  const iconUrl = provider.iconUrl?.trim()
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) return iconUrl
  const hostname = homepageHostname(provider.homepageUrl)
  if (hostname) return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}`
  return null
}

function homepageHostname(homepageUrl: string | undefined): string | null {
  if (!homepageUrl) return null
  try {
    return new URL(homepageUrl).hostname || null
  } catch {
    return null
  }
}
