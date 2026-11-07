// The daemon's Azure DevOps REST helpers for hook turns (azure-devops-integration.md §11.5): the repository's API root, the version, and the headers.
import { AZURE_DEVOPS_HOST, type AzureDevOpsRepoRouting } from '@agentconnect.md/protocol'
import { parseCodeHostJson } from '../codehost/json.js'

export const AZURE_DEVOPS_API_VERSION = '7.1'

/** `https://dev.azure.com/{organization}/{project GUID}/_apis/git/repositories/{repository GUID}`, from trusted routing only. */
export function azureDevOpsRepositoryApi(routing: AzureDevOpsRepoRouting): string {
  const { organization, projectId, repositoryId } = routing
  return `https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(organization)}/${projectId}/_apis/git/repositories/${repositoryId}`
}

/** One request URL below the repository's API root, with the pinned API version. */
export function azureDevOpsUrl(apiBaseUrl: string, path: string): string {
  return `${apiBaseUrl}${path}?api-version=${AZURE_DEVOPS_API_VERSION}`
}

/** A bearer token, JSON, and the header that turns a rejected token into a 401 rather than a sign-in page. */
export function azureDevOpsHeaders(token: string, body: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'x-tfs-fedauthredirect': 'Suppress',
    ...(body ? { 'content-type': 'application/json' } : {})
  }
}

export class AzureDevOpsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string
  ) {
    super(`Azure DevOps GET ${path} failed with ${status}`)
    this.name = 'AzureDevOpsRequestError'
  }

  get authRejected(): boolean {
    return this.status === 401 || this.status === 403
  }
}

export interface AzureDevOpsReadClient {
  apiBaseUrl: string
  token: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** One GET below the repository's API root; the parsed body, or a typed failure. */
export async function azureDevOpsGet(client: AzureDevOpsReadClient, path: string): Promise<unknown> {
  const res = await (client.fetchImpl ?? fetch)(azureDevOpsUrl(client.apiBaseUrl, path), {
    method: 'GET',
    headers: azureDevOpsHeaders(client.token, false),
    redirect: 'error',
    ...(client.signal ? { signal: client.signal } : {})
  })
  if (!res.ok) {
    void res.body?.cancel().catch(() => {})
    throw new AzureDevOpsRequestError(res.status, path)
  }
  const raw = await res.text()
  return raw.trim() ? parseCodeHostJson(raw) : undefined
}
