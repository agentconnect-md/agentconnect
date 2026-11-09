import {
  AzureDevOpsApiError,
  azureDevOpsCall,
  type AzureDevOpsApiClient,
  type AzureDevOpsMicrosoftIdentity
} from './api.js'
import type { MicrosoftIdentity } from '../github/logto-identity.js'

export const PROJECT_NAMESPACE = '52d39943-cb85-4d7f-8fa8-c6baac873819'
const API_VERSION = '7.1'
const MAX_PAGES = 20

const same = (value: unknown, expected: string): boolean =>
  typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()

function invalidEvidence(): never {
  throw new AzureDevOpsApiError('Azure DevOps returned incomplete permission information', 200, 'UNAVAILABLE', true)
}

export interface AzureDevOpsUserAccessLevel {
  accountLicenseType?: unknown
  licensingSource?: unknown
  msdnLicenseType?: unknown
  gitHubLicenseType?: unknown
  status?: unknown
}

// Use the basic search: individual entitlement details require unrelated user-administration permissions.
export async function readUserAccessLevel(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  tenantId: string,
  linked: MicrosoftIdentity,
  identity: AzureDevOpsMicrosoftIdentity
): Promise<AzureDevOpsUserAccessLevel | null> {
  type Entitlement = {
    id?: unknown
    user?: { origin?: unknown; originId?: unknown; domain?: unknown; subjectKind?: unknown }
    accessLevel?: AzureDevOpsUserAccessLevel
  }
  const query = new URLSearchParams({
    $filter: `name eq '${linked.email.replaceAll("'", "''")}'`,
    'api-version': API_VERSION
  })
  let matched: AzureDevOpsUserAccessLevel | null = null
  const cursors = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await azureDevOpsCall<{ items?: Entitlement[]; continuationToken?: unknown }>(
      api,
      token,
      organization,
      `https://vsaex.dev.azure.com/${encodeURIComponent(organization)}/_apis/userentitlements?${query}`
    )
    if (!Array.isArray(result?.items)) invalidEvidence()
    for (const row of result.items) {
      if (!same(row?.id, identity.id)) continue
      if (
        matched ||
        !row.accessLevel ||
        typeof row.accessLevel !== 'object' ||
        !same(row.user?.origin, 'aad') ||
        !same(row.user?.subjectKind, 'user') ||
        !same(row.user?.originId, linked.objectId) ||
        !same(row.user?.domain, tenantId)
      )
        invalidEvidence()
      matched = row.accessLevel
    }
    const next = result.continuationToken
    if (next === null || next === undefined || next === '') return matched
    if (typeof next !== 'string' || cursors.has(next)) invalidEvidence()
    cursors.add(next)
    query.set('continuationToken', next)
  }
  return invalidEvidence()
}

// The provider's effective fields already resolve group membership, parent inheritance and child overrides.
export async function readEffectivePermissionBits(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  namespace: string,
  resource: string,
  descriptor: string
): Promise<number> {
  type Ace = { descriptor?: unknown; extendedInfo?: { effectiveAllow?: unknown; effectiveDeny?: unknown } }
  const query = new URLSearchParams({
    token: resource,
    descriptors: descriptor,
    includeExtendedInfo: 'true',
    recurse: 'false',
    'api-version': API_VERSION
  })
  const result = await azureDevOpsCall<{ value?: Array<{ token?: unknown; acesDictionary?: Record<string, Ace> }> }>(
    api,
    token,
    organization,
    `${api.devOpsBaseUrl}/${encodeURIComponent(organization)}/_apis/accesscontrollists/${namespace}?${query}`
  )
  if (!Array.isArray(result?.value)) invalidEvidence()
  const lists = result.value.filter((list) => same(list?.token, resource))
  if (lists.length === 0) return 0
  if (lists.length !== 1) invalidEvidence()
  const entries = Object.entries(lists[0]!.acesDictionary ?? {}).filter(([key]) => same(key, descriptor))
  if (entries.length === 0) return 0
  if (entries.length !== 1) invalidEvidence()
  const ace = entries[0]![1]
  if (!ace || !same(ace.descriptor, descriptor) || !ace.extendedInfo || typeof ace.extendedInfo !== 'object') {
    invalidEvidence()
  }
  const allow = ace.extendedInfo.effectiveAllow === undefined ? 0 : ace.extendedInfo.effectiveAllow
  const deny = ace.extendedInfo.effectiveDeny === undefined ? 0 : ace.extendedInfo.effectiveDeny
  const isBits = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
  if (!isBits(allow) || !isBits(deny)) invalidEvidence()
  return allow & ~deny
}

export async function readProjectVisibility(
  api: AzureDevOpsApiClient,
  token: string,
  organization: string,
  projectId: string
): Promise<'private' | 'public'> {
  const project = await azureDevOpsCall<{ id?: unknown; visibility?: unknown }>(
    api,
    token,
    organization,
    `${api.devOpsBaseUrl}/${encodeURIComponent(organization)}/_apis/projects/${encodeURIComponent(projectId)}?api-version=${API_VERSION}`
  )
  if (!same(project?.id, projectId) || (project?.visibility !== 'private' && project?.visibility !== 'public')) {
    invalidEvidence()
  }
  return project.visibility
}

// An assigned subscriber category or sign-in grace period does not prove a recognized repository entitlement.
export function userLicenseAllowsRepositories(
  level: AzureDevOpsUserAccessLevel,
  visibility: 'private' | 'public'
): boolean {
  if (!['active', 'pending'].some((status) => same(level.status, status))) return false
  if (same(level.licensingSource, 'account')) {
    return (
      (visibility === 'public' && same(level.accountLicenseType, 'stakeholder')) ||
      ['express', 'professional', 'advanced'].some((license) => same(level.accountLicenseType, license))
    )
  }
  if (same(level.licensingSource, 'github') && same(level.gitHubLicenseType, 'enterprise')) return true
  return (
    same(level.licensingSource, 'msdn') &&
    ['professional', 'platforms', 'testProfessional', 'premium', 'ultimate', 'enterprise'].some((license) =>
      same(level.msdnLicenseType, license)
    )
  )
}
