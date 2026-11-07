// A stateful fake of the Entra token endpoint and dev.azure.com, shaped like azure-devops-integration.md §12's answers; every identifier is synthetic.
import { AzureDevOpsApiClient, type FetchLike } from '../../src/azure-devops/api.js'

// The fixed hosts themselves: the fake answers in place of the network, so the production URLs are what is exercised.
export const LOGIN_BASE = 'https://login.microsoftonline.com'
export const DEVOPS_BASE = 'https://dev.azure.com'

export const TENANT_ID = '00000000-0000-4000-8000-0000000000a1'
export const CLIENT_ID = '00000000-0000-4000-8000-0000000000c1'
export const DEPLOYMENT_CLIENT_ID = '00000000-0000-4000-8000-0000000000d1'
export const INSTANCE_ID = '00000000-0000-4000-8000-0000000000e1'
export const IDENTITY_ID = '00000000-0000-4000-8000-0000000000f1'
export const PROJECT_ID = '00000000-0000-4000-8000-000000000001'
export const REPOSITORY_ID = '00000000-0000-4000-8000-000000000002'
export const SECOND_REPOSITORY_ID = '00000000-0000-4000-8000-000000000003'
export const ORGANIZATION = 'example-org'
export const PROJECT = 'Example Project'
export const REPOSITORY = 'Example Repo'

export interface FakeAzureRepository {
  id: string
  name: string
  projectId: string
  projectName: string
  defaultBranch?: string
  isDisabled?: boolean
  isInMaintenance?: boolean
  /** Whether the identity holds GenericContribute (§12 item 7). */
  contribute: boolean
}

export interface FakeAzureDevOpsOptions {
  /** client ID → the one secret Entra accepts for it. */
  secrets?: Record<string, string>
  repositories?: FakeAzureRepository[]
  expiresInSec?: number
}

export function exampleRepository(overrides: Partial<FakeAzureRepository> = {}): FakeAzureRepository {
  return {
    id: REPOSITORY_ID,
    name: REPOSITORY,
    projectId: PROJECT_ID,
    projectName: PROJECT,
    defaultBranch: 'refs/heads/main',
    contribute: true,
    ...overrides
  }
}

export class FakeAzureDevOps {
  readonly requests: Array<{ method: string; url: string }> = []
  secrets: Record<string, string>
  repositories: FakeAzureRepository[]
  expiresInSec: number
  /** Which identity and organization connectionData reports. */
  identityId = IDENTITY_ID
  instanceId = INSTANCE_ID
  /** When set, every dev.azure.com call answers 401 with this TF code (`TF401444`, `TF400813`). */
  revoked: string | undefined
  /** When set, the next dev.azure.com call answers a plain 401, as for a token that went stale. */
  staleTokenOnce = false
  /** When set, the next dev.azure.com call answers 429 with this Retry-After. */
  throttleOnceSec: number | undefined
  tokensIssued = 0
  readonly api: AzureDevOpsApiClient

  constructor(opts: FakeAzureDevOpsOptions = {}, now?: () => number) {
    this.secrets = opts.secrets ?? { [CLIENT_ID]: 'example-secret' }
    this.repositories = opts.repositories ?? [exampleRepository()]
    this.expiresInSec = opts.expiresInSec ?? 3599
    this.api = new AzureDevOpsApiClient({ fetch: this.fetch, ...(now ? { now } : {}) })
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    this.requests.push({ method, url })
    if (url.startsWith(`${LOGIN_BASE}/`)) return this.token(url, String(init?.body ?? ''))
    if (url.startsWith(`${DEVOPS_BASE}/`)) return this.devOps(url, method, init)
    return this.json(404, { message: 'unknown host' })
  }

  private token(url: string, body: string): Response {
    const form = new URLSearchParams(body)
    if (!url.endsWith(`/${TENANT_ID}/oauth2/v2.0/token`)) {
      return this.json(400, { error: 'invalid_request', error_codes: [90002] })
    }
    const clientId = form.get('client_id') ?? ''
    if (!(clientId in this.secrets)) return this.json(400, { error: 'unauthorized_client', error_codes: [700016] })
    if (this.secrets[clientId] !== form.get('client_secret')) {
      return this.json(401, {
        error: 'invalid_client',
        error_description: 'AADSTS7000215: Invalid client secret provided.',
        error_codes: [7000215]
      })
    }
    this.tokensIssued += 1
    return this.json(200, {
      token_type: 'Bearer',
      expires_in: this.expiresInSec,
      access_token: `example-token-${this.tokensIssued}`
    })
  }

  private devOps(url: string, method: string, init?: RequestInit): Response {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (!auth.startsWith('Bearer example-token-')) return this.json(401, { message: 'TF400813: unauthorized' })
    if (this.revoked) {
      return this.json(401, { message: `${this.revoked}: The user is not authorized to access this resource.` })
    }
    if (this.staleTokenOnce) {
      this.staleTokenOnce = false
      return this.json(401, { message: 'The token is no longer valid.' })
    }
    if (this.throttleOnceSec !== undefined) {
      const seconds = this.throttleOnceSec
      this.throttleOnceSec = undefined
      return this.json(429, { message: 'throttled' }, { 'retry-after': String(seconds) })
    }
    const path = new URL(url).pathname
    if (path === `/${ORGANIZATION}/_apis/connectionData`) {
      return this.json(200, {
        authenticatedUser: { id: this.identityId, providerDisplayName: 'Example Application' },
        authorizedUser: { id: this.identityId },
        instanceId: this.instanceId
      })
    }
    if (path === `/${ORGANIZATION}/_apis/git/repositories` && method === 'GET') {
      return this.json(200, {
        count: this.repositories.length,
        value: this.repositories.map((repo) => ({
          id: repo.id,
          name: repo.name,
          project: { id: repo.projectId, name: repo.projectName, state: 'wellFormed' },
          defaultBranch: repo.defaultBranch,
          remoteUrl: `https://${ORGANIZATION}@dev.azure.com/${ORGANIZATION}/${encodeURIComponent(repo.projectName)}/_git/${encodeURIComponent(repo.name)}`,
          isDisabled: repo.isDisabled ?? false,
          ...(repo.isInMaintenance !== undefined ? { isInMaintenance: repo.isInMaintenance } : {})
        }))
      })
    }
    if (path === `/${ORGANIZATION}/_apis/security/permissionevaluationbatch` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        evaluations: Array<{ securityNamespaceId: string; token: string; permissions: number }>
      }
      return this.json(200, {
        evaluations: body.evaluations.map((evaluation) => {
          const repositoryId = evaluation.token.split('/')[2]
          const repo = this.repositories.find((r) => r.id === repositoryId)
          const value = repo ? (evaluation.permissions === 4 ? repo.contribute : true) : false
          return { ...evaluation, value }
        })
      })
    }
    return this.json(404, { message: 'not found' })
  }
}
