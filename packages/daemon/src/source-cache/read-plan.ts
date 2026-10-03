import type { Agent } from '../agents/agent-schema.js'
import { credentialProviderOf } from '../codehost/credentials.js'
import type { LocalStore, SourceCacheObjectRow } from '../store/local-store.js'
import type { BundleFallbackReason } from '../workspace/bundled-clone.js'
import type { AuthorizeCredentialedCacheRead } from './authorize-read.js'
import {
  anonRepoId,
  parseSourceCacheObjectKey,
  pointerKey,
  type SourceCacheClass,
  type SourceCacheObjectKey,
  type SourceCacheShape
} from './keys.js'
import type { SourceCachePresigner } from './presigner.js'

// The workspace read planner (source-cache.md §5, §7): which bundle, if any, a clone may start from; any doubt is a miss.

export interface WorkspaceBundleRequest {
  agent: Agent
  /** The URL the clone fetches; an anonymous workspace is keyed by it. */
  cloneUrl: string
  branch: string
  shape: SourceCacheShape
}

export interface WorkspaceBundlePlan {
  /** A presigned GET; never logged. */
  url: string
  bundleKey: SourceCacheObjectKey
  pointerKey: SourceCacheObjectKey
  repoClass: SourceCacheClass
  shape: SourceCacheShape
  /** When the bundle row was written, for the write-back age trigger. */
  bundleCreatedAt: number
}

/** Where a write-back of this clone may land: set once the clone's own identity resolved, never from the pod. */
export interface SourceCacheWriteTarget {
  orgId: string
  repoClass: SourceCacheClass
  repoId: string
  ref: string
  shape: SourceCacheShape
  pointerKey: SourceCacheObjectKey
  /** The pointer row's target when planned (null for none), the write-back's compare-and-set expectation. */
  observedTargetKey: string | null
}

export interface WorkspaceCachePlan {
  bundle?: WorkspaceBundlePlan
  target?: SourceCacheWriteTarget
}

export type SourceCacheMissReason =
  | 'no-org'
  | 'unsupported-credential'
  | 'unauthorized'
  | 'no-pointer'
  | 'unusable-pointer'
  | 'unusable-bundle'
  | 'not-https'
  | 'error'

export type SourceCacheReadOutcome =
  | { kind: 'hit'; bundleKey: string; shape: SourceCacheShape }
  | { kind: 'miss'; reason: SourceCacheMissReason; shape: SourceCacheShape; detail?: string }
  | { kind: 'fallback'; bundleKey: string; shape: SourceCacheShape; reason: BundleFallbackReason; detail: string }

export interface SourceCacheWorkspaceReader {
  /** A bundle to seed this clone with and where its write-back may land, either possibly absent; never throws. */
  plan(request: WorkspaceBundleRequest): Promise<WorkspaceCachePlan>
  /** Where a clone's cache outcome goes: logged today, the CP1.8 metrics hook. */
  record(outcome: SourceCacheReadOutcome): void
}

export interface SourceCacheReadPlannerDeps {
  store: () => Pick<LocalStore, 'getSourceCacheObject' | 'touchSourceCacheRead'> | undefined
  presigner: Pick<SourceCachePresigner, 'presignGet'>
  authorize: AuthorizeCredentialedCacheRead
  orgForAgent: (agentId: string) => string | undefined
  now?: () => number
  log: { debug(message: string): void; warn(message: string): void }
  onOutcome?: (outcome: SourceCacheReadOutcome) => void
}

class Miss extends Error {
  constructor(
    readonly reason: SourceCacheMissReason,
    detail: string
  ) {
    super(detail)
  }
}

const miss = (reason: SourceCacheMissReason, detail: string): never => {
  throw new Miss(reason, detail)
}

/** A committed, unclaimed row of the expected kind; a sweep claim counts as gone. */
function usable(row: SourceCacheObjectRow | undefined, kind: SourceCacheObjectRow['kind']): boolean {
  return row !== undefined && row.kind === kind && row.state === 'committed' && row.claimedBy === null
}

export function createSourceCacheReadPlanner(deps: SourceCacheReadPlannerDeps): SourceCacheWorkspaceReader {
  const now = deps.now ?? Date.now

  const record = (outcome: SourceCacheReadOutcome): void => {
    if (outcome.kind === 'fallback') {
      deps.log.warn(
        `source cache: fallback to an origin clone (bundle=${outcome.bundleKey} shape=${outcome.shape} reason=${outcome.reason}: ${outcome.detail})`
      )
    } else if (outcome.kind === 'hit') {
      deps.log.debug(`source cache: clone seeded from ${outcome.bundleKey} (${outcome.shape})`)
    } else {
      const line = `source cache: miss (${outcome.shape} reason=${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''})`
      if (outcome.reason === 'error' || outcome.reason === 'not-https') deps.log.warn(line)
      else deps.log.debug(line)
    }
    try {
      deps.onOutcome?.(outcome)
    } catch {
      // A metrics hook never fails a clone.
    }
  }

  /** The access class and repository id the workspace's own `credential?` selects (§4, §7). */
  const repositoryOf = async (
    request: WorkspaceBundleRequest
  ): Promise<{ repoClass: SourceCacheClass; repo: string }> => {
    const { agent } = request
    const credential = agent.workspace.mode === 'git-repo' ? agent.workspace.gitCredential : undefined
    if (credential === undefined) return { repoClass: 'anon', repo: anonRepoId(request.cloneUrl) }
    if (credentialProviderOf(credential) === undefined) miss('unsupported-credential', credential)
    // No cred GET without a resolution success for this agent (§5).
    const decision = await deps.authorize(agent)
    if (!decision.ok) return miss('unauthorized', `${decision.reason}/${decision.detail}`)
    if (decision.ref !== `refs/heads/${request.branch}`) miss('unauthorized', 'ref_mismatch')
    return { repoClass: 'cred', repo: decision.credRepoId }
  }

  const resolve = async (
    request: WorkspaceBundleRequest,
    found: { target?: SourceCacheWriteTarget }
  ): Promise<WorkspaceBundlePlan> => {
    const orgId = deps.orgForAgent(request.agent.id)
    if (orgId === undefined) return miss('no-org', request.agent.id)
    const store = deps.store() ?? miss('error', 'store not open')
    const { repoClass, repo } = await repositoryOf(request)
    const ref = `refs/heads/${request.branch}`
    const latest = pointerKey({ org: orgId, class: repoClass, repo, ref, shape: request.shape })
    // The pointer row's targetKey names the bundle, so resolution needs no object-store GET (§4).
    const pointer = await store.getSourceCacheObject(orgId, latest)
    found.target = {
      orgId,
      repoClass,
      repoId: repo,
      ref,
      shape: request.shape,
      pointerKey: latest,
      observedTargetKey: pointer?.targetKey ?? null
    }
    if (pointer === undefined) return miss('no-pointer', latest)
    if (!usable(pointer, 'pointer') || pointer.targetKey === null) return miss('unusable-pointer', latest)
    const target = parseSourceCacheObjectKey(pointer.targetKey)
    if (
      target?.kind !== 'bundle' ||
      target.orgId !== orgId ||
      target.repoClass !== repoClass ||
      target.repoId !== repo
    ) {
      return miss('unusable-pointer', latest)
    }
    const bundleKey = pointer.targetKey as SourceCacheObjectKey
    const bundle = await store.getSourceCacheObject(orgId, bundleKey)
    if (
      !usable(bundle, 'bundle') ||
      bundle!.shape !== request.shape ||
      bundle!.repoClass !== repoClass ||
      bundle!.repoId !== repo ||
      bundle!.refHash !== pointer.refHash
    ) {
      return miss('unusable-bundle', bundleKey)
    }
    const { url } = await deps.presigner.presignGet(bundleKey)
    if (!url.startsWith('https://')) return miss('not-https', bundleKey)
    // Stamped on GET issuance only; a lost stamp costs eviction accuracy, never the read.
    const at = now()
    await Promise.all([latest, bundleKey].map((key) => store.touchSourceCacheRead({ orgId, key, at }))).catch(
      (err: unknown) => {
        deps.log.warn(`source cache: could not record a read of ${bundleKey} (${(err as Error).message})`)
      }
    )
    return { url, bundleKey, pointerKey: latest, repoClass, shape: request.shape, bundleCreatedAt: bundle!.createdAt }
  }

  return {
    record,
    async plan(request) {
      const found: { target?: SourceCacheWriteTarget } = {}
      try {
        const bundle = await resolve(request, found)
        return { bundle, ...(found.target ? { target: found.target } : {}) }
      } catch (err) {
        if (err instanceof Miss) {
          record({ kind: 'miss', reason: err.reason, shape: request.shape, detail: err.message })
        } else {
          record({
            kind: 'miss',
            reason: 'error',
            shape: request.shape,
            detail: (err as Error)?.message ?? String(err)
          })
        }
        return found.target ? { target: found.target } : {}
      }
    }
  }
}
