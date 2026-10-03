// GitLab's member of the code-host repository seam: the project API by numeric id, then the branch's commit.
import { parseCodeHostJson } from '../codehost/json.js'
import type {
  CodeHostRepositoryModule,
  ProviderAnswer,
  ProviderResolveContext,
  ProviderResolveInput
} from '../codehost/repository.js'
import { discardResponse, fetchWithRedirectPolicy, readBoundedBody, retryAfterMs } from '../codehost/rest-read.js'
import { gitlabApiBaseUrl } from './api-base.js'

const MAX_METADATA_BYTES = 256 * 1024
const COMMIT_SHA = /^[0-9a-f]{40}$/i
const LABEL = 'GitLab source resolution'

type Failure = Extract<ProviderAnswer, { ok: false }>

async function get(
  input: ProviderResolveInput,
  ctx: ProviderResolveContext,
  path: string,
  ifNoneMatch?: string
): Promise<Response | Failure> {
  try {
    // Concatenated onto the API root, never URL-resolved, so an instance path prefix survives.
    return await fetchWithRedirectPolicy(
      ctx.fetch,
      new URL(`${input.apiBaseUrl}${path}`),
      {
        method: 'GET',
        signal: ctx.signal,
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'user-agent': 'agentconnect-daemon',
          'private-token': input.token,
          ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {})
        }
      },
      'error',
      LABEL
    )
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'network' }
  }
}

async function failure(response: Response, missing: Failure['reason'], ctx: ProviderResolveContext): Promise<Failure> {
  const status = response.status
  const wait = retryAfterMs(response, ctx.now)
  await discardResponse(response)
  if (status === 401) return { ok: false, reason: 'access_denied', detail: 'token_rejected', tokenRejected: true }
  if (status === 403) return { ok: false, reason: 'access_denied', detail: 'forbidden' }
  if (status === 404) return { ok: false, reason: missing, detail: `status_${status}` }
  if (status === 429)
    return { ok: false, reason: 'unavailable', detail: 'rate_limited', ...(wait ? { retryAfterMs: wait } : {}) }
  return { ok: false, reason: 'unavailable', detail: `status_${status}` }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = parseCodeHostJson((await readBoundedBody(response, MAX_METADATA_BYTES, LABEL)).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const idText = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : undefined

async function resolve(input: ProviderResolveInput, ctx: ProviderResolveContext): Promise<ProviderAnswer> {
  const { repository, prior } = input
  const identityEtag = prior?.identityPath !== undefined ? prior.identityEtag : undefined
  const project = await get(input, ctx, `/projects/${repository.externalId}`, identityEtag)
  if (!(project instanceof Response)) return project
  let pathWithNamespace: string
  let nextIdentityEtag: string | undefined
  if (project.status === 304 && identityEtag !== undefined && prior?.identityPath !== undefined) {
    await discardResponse(project)
    pathWithNamespace = prior.identityPath
    nextIdentityEtag = identityEtag
  } else if (project.status === 200) {
    nextIdentityEtag = project.headers.get('etag') ?? undefined
    const record = await readJson(project)
    if (!record || typeof record.path_with_namespace !== 'string') {
      return { ok: false, reason: 'unavailable', detail: 'invalid_metadata' }
    }
    if (idText(record.id) !== repository.externalId) return { ok: false, reason: 'replaced', detail: 'id_mismatch' }
    pathWithNamespace = record.path_with_namespace
  } else {
    return failure(project, 'not_found', ctx)
  }
  if (pathWithNamespace.toLowerCase() !== repository.path.toLowerCase()) {
    return { ok: false, reason: 'replaced', detail: 'renamed' }
  }
  const validators = {
    ...(nextIdentityEtag ? { identityEtag: nextIdentityEtag } : {}),
    identityPath: pathWithNamespace
  }

  // Identity proves access, so a pinned commit is taken as given (source-cache.md §5).
  if (input.ref.kind === 'commit') return { ok: true, commit: input.ref.sha, validators }

  const branchPath = `/projects/${repository.externalId}/repository/branches/${encodeURIComponent(input.ref.name)}`
  const conditional = prior?.refEtag !== undefined && prior.commit !== undefined ? prior.refEtag : undefined
  let branch = await get(input, ctx, branchPath, conditional)
  if (!(branch instanceof Response)) return branch
  if (branch.status === 304) {
    await discardResponse(branch)
    if (conditional !== undefined && prior?.commit !== undefined) {
      return {
        ok: true,
        commit: prior.commit,
        validators: { ...validators, refEtag: conditional, commit: prior.commit }
      }
    }
    branch = await get(input, ctx, branchPath)
    if (!(branch instanceof Response)) return branch
  }
  if (branch.status !== 200) return failure(branch, 'ref_not_found', ctx)
  const refEtag = branch.headers.get('etag') ?? undefined
  const record = await readJson(branch)
  const commit =
    record?.commit && typeof record.commit === 'object' ? (record.commit as Record<string, unknown>).id : undefined
  if (typeof commit !== 'string' || !COMMIT_SHA.test(commit)) {
    return { ok: false, reason: 'unavailable', detail: 'invalid_sha' }
  }
  const sha = commit.toLowerCase()
  return { ok: true, commit: sha, validators: { ...validators, ...(refEtag ? { refEtag } : {}), commit: sha } }
}

export const gitlabRepository: CodeHostRepositoryModule = {
  provider: 'gitlab',
  apiBaseUrl: (spec) => gitlabApiBaseUrl(spec.gitlabHost),
  // The binding's read PAT (read_api + read_repository) on the glab plane, so the write-capable git key is never touched.
  readTokenAsk: (repository) => ({
    plane: 'glab',
    provider: 'gitlab',
    ...(repository.externalId !== undefined ? { externalRepoId: repository.externalId } : {}),
    requestedAccess: 'read'
  }),
  resolve
}
