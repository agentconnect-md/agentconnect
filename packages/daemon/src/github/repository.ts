// GitHub's member of the code-host repository seam: identity by numeric id, then a conditional commit lookup.
import { concreteRef } from '../codehost/ref-spec.js'
import type {
  CodeHostRepositoryModule,
  ProviderAnswer,
  ProviderResolveContext,
  ProviderResolveInput
} from '../codehost/repository.js'
import { discardResponse, fetchWithRedirectPolicy, readBoundedBody, retryAfterMs } from '../codehost/rest-read.js'
import { GITHUB_API_BASE, githubApiHeaders, isGithubRateLimited, parseGithubRepositoryIdentity } from './rest.js'

const MAX_METADATA_BYTES = 128 * 1024
const MAX_SHA_BYTES = 128
const COMMIT_SHA = /^[0-9a-f]{40}$/i
const LABEL = 'GitHub source resolution'

type Failure = Extract<ProviderAnswer, { ok: false }>

async function get(
  input: ProviderResolveInput,
  ctx: ProviderResolveContext,
  path: string,
  accept: string,
  ifNoneMatch?: string
): Promise<Response | Failure> {
  try {
    return await fetchWithRedirectPolicy(
      ctx.fetch,
      new URL(`${input.apiBaseUrl}${path}`),
      {
        method: 'GET',
        signal: ctx.signal,
        headers: githubApiHeaders({ accept, token: input.token, ...(ifNoneMatch ? { ifNoneMatch } : {}) })
      },
      'error',
      LABEL
    )
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'network' }
  }
}

/** Classify a non-success status shared by both calls; `missing` names what a 404 means at this step. */
async function failure(response: Response, missing: Failure['reason'], ctx: ProviderResolveContext): Promise<Failure> {
  const status = response.status
  const wait = retryAfterMs(response, ctx.now)
  const limited = isGithubRateLimited(response)
  await discardResponse(response)
  if (status === 401) return { ok: false, reason: 'access_denied', detail: 'token_rejected', tokenRejected: true }
  if (limited)
    return { ok: false, reason: 'unavailable', detail: 'rate_limited', ...(wait ? { retryAfterMs: wait } : {}) }
  if (status === 403) return { ok: false, reason: 'access_denied', detail: 'forbidden' }
  if (status === 404) return { ok: false, reason: missing, detail: `status_${status}` }
  if (status === 422 && missing === 'ref_not_found') return { ok: false, reason: missing, detail: `status_${status}` }
  return { ok: false, reason: 'unavailable', detail: `status_${status}` }
}

async function resolve(input: ProviderResolveInput, ctx: ProviderResolveContext): Promise<ProviderAnswer> {
  const { repository, prior } = input
  // A `HEAD` ask revalidates only when the prior read recorded the default branch a 304 must stand for.
  const identityEtag =
    prior?.identityPath !== undefined && (input.ref.kind !== 'default' || prior.defaultBranch !== undefined)
      ? prior.identityEtag
      : undefined
  const identity = await get(
    input,
    ctx,
    `/repositories/${repository.externalId}`,
    'application/vnd.github+json',
    identityEtag
  )
  if (!(identity instanceof Response)) return identity
  let fullName: string
  let nextIdentityEtag: string | undefined
  let defaultBranch: string | undefined
  if (identity.status === 304 && identityEtag !== undefined && prior?.identityPath !== undefined) {
    await discardResponse(identity)
    fullName = prior.identityPath
    nextIdentityEtag = identityEtag
    defaultBranch = prior.defaultBranch
  } else if (identity.status === 200) {
    nextIdentityEtag = identity.headers.get('etag') ?? undefined
    let raw: string
    try {
      raw = (await readBoundedBody(identity, MAX_METADATA_BYTES, LABEL)).toString('utf8')
    } catch {
      return { ok: false, reason: 'unavailable', detail: 'invalid_metadata' }
    }
    const parsed = parseGithubRepositoryIdentity(raw)
    if (!parsed || parsed.fullName === undefined)
      return { ok: false, reason: 'unavailable', detail: 'invalid_metadata' }
    if (parsed.id !== repository.externalId) return { ok: false, reason: 'replaced', detail: 'id_mismatch' }
    fullName = parsed.fullName
    defaultBranch = parsed.defaultBranch
  } else {
    return failure(identity, 'not_found', ctx)
  }
  if (fullName.toLowerCase() !== repository.path.toLowerCase()) {
    return { ok: false, reason: 'replaced', detail: 'renamed' }
  }
  const validators = {
    ...(nextIdentityEtag ? { identityEtag: nextIdentityEtag } : {}),
    identityPath: fullName,
    ...(defaultBranch !== undefined ? { defaultBranch } : {})
  }

  // Identity proves access, so a pinned commit is taken as given (source-cache.md §5).
  if (input.ref.kind === 'commit') return { ok: true, commit: input.ref.sha, validators }
  const target = concreteRef(input.ref, defaultBranch)
  if (!target) return { ok: false, reason: 'unavailable', detail: 'invalid_metadata' }

  const refPath = `/repos/${fullName}/commits/${encodeURIComponent(`${target.kind === 'tag' ? 'tags' : 'heads'}/${target.name}`)}`
  // A moved default branch is another ref, so the old branch's etag never revalidates it.
  const sameRef = input.ref.kind !== 'default' || prior?.defaultBranch === defaultBranch
  const conditional = sameRef && prior?.refEtag !== undefined && prior.commit !== undefined ? prior.refEtag : undefined
  let lookup = await get(input, ctx, refPath, 'application/vnd.github.sha', conditional)
  if (!(lookup instanceof Response)) return lookup
  if (lookup.status === 304) {
    await discardResponse(lookup)
    if (conditional !== undefined && prior?.commit !== undefined) {
      return {
        ok: true,
        commit: prior.commit,
        ref: target.fullName,
        validators: { ...validators, refEtag: conditional, commit: prior.commit }
      }
    }
    lookup = await get(input, ctx, refPath, 'application/vnd.github.sha')
    if (!(lookup instanceof Response)) return lookup
  }
  if (lookup.status !== 200) return failure(lookup, 'ref_not_found', ctx)
  const refEtag = lookup.headers.get('etag') ?? undefined
  let commit: string
  try {
    commit = (await readBoundedBody(lookup, MAX_SHA_BYTES, LABEL)).toString('utf8').trim()
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'invalid_sha' }
  }
  if (!COMMIT_SHA.test(commit)) return { ok: false, reason: 'unavailable', detail: 'invalid_sha' }
  const sha = commit.toLowerCase()
  return {
    ok: true,
    commit: sha,
    ref: target.fullName,
    validators: { ...validators, ...(refEtag ? { refEtag } : {}), commit: sha }
  }
}

export const githubRepository: CodeHostRepositoryModule = {
  provider: 'github',
  apiBaseUrl: () => GITHUB_API_BASE,
  // The git-plane token (metadata:read plus contents): the workspace's, or one scoped to a named skill repository.
  readTokenAsk: (repository) => ({
    plane: 'git',
    ...(repository.repoFullName !== undefined ? { repoFullName: repository.repoFullName } : {})
  }),
  resolve
}
