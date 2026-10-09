import {
  addressFor,
  createCredentialsProvider,
  createObjectClient,
  type ReadTextFile,
  type SourceCacheObjectClient as BucketObjectClient
} from '@agentconnect.md/object-store'
import { loadSourceCacheConfig, SOURCE_CACHE_ENV, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import { parseSourceCacheObjectKey, type SourceCacheObjectKey } from './keys.js'
import { createPresigner, type SourceCachePresigner } from './presigner.js'

// Pool-member Source Cache wiring (source-cache.md §12): absent config means no signer, no I/O, no state.

/** The member's own object requests, which touch bundle objects alone: pointers are store rows (§4). */
export type SourceCacheObjectClient = BucketObjectClient<SourceCacheObjectKey>

const isBundleKey = (key: string): key is SourceCacheObjectKey => parseSourceCacheObjectKey(key)?.kind === 'bundle'

export interface SourceCache {
  config: SourceCacheConfig
  presigner: SourceCachePresigner
  /** Header-signed HEAD, retag, delete and lifecycle read the member runs itself (§9, §10). */
  objects: SourceCacheObjectClient
}

export interface CreateSourceCacheOptions {
  env: NodeJS.ProcessEnv
  k8s: boolean
  fetch?: typeof fetch
  now?: () => number
  readFile?: ReadTextFile
  log?: { info(message: string): void; warn(message: string): void }
}

/** Build the member's signer, or undefined outside --k8s or when unconfigured; an invalid enabled config throws. */
export function createSourceCache(opts: CreateSourceCacheOptions): SourceCache | undefined {
  if (!opts.k8s) {
    if (opts.env[SOURCE_CACHE_ENV]?.trim()) opts.log?.warn(`${SOURCE_CACHE_ENV} is ignored outside --k8s`)
    return undefined
  }
  const config = loadSourceCacheConfig(opts.env)
  if (!config) return undefined
  const credentials = createCredentialsProvider(config.credentials, {
    region: config.region,
    env: opts.env,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
    ...(opts.now ? { now: opts.now } : {})
  })
  const presigner = createPresigner({ config, credentials, ...(opts.now ? { now: opts.now } : {}) })
  const objects = createObjectClient({
    config,
    credentials,
    isKey: isBundleKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {})
  })
  const endpoint = sourceCacheEndpoint(config)
  const style = addressFor(endpoint, config.bucket, config.forcePathStyle).style
  opts.log?.info(
    `source cache enabled (bucket=${config.bucket} prefix=${config.prefix || '(none)'} endpoint=${new URL(endpoint).host} credentials=${credentials.source} addressing=${style})`
  )
  return { config, presigner, objects }
}

export type { SourceCacheConfig } from './config.js'
export type { PresignedRequest, SourceCachePresigner } from './presigner.js'
export {
  createCredentialedCacheReadAuthorizer,
  type AuthorizeCredentialedCacheRead,
  type CredentialedCacheReadAuthorizerDeps,
  type CredentialedCacheReadDecision
} from './authorize-read.js'
export {
  createSkillReadPlanner,
  createSourceCacheReadPlanner,
  type SkillBundleRequest,
  type SkillCachePlan,
  type SourceCacheSkillReader,
  type SourceCacheMissReason,
  type SourceCacheReadOutcome,
  type SourceCacheReadPlannerDeps,
  type SourceCacheWorkspaceReader,
  type SourceCacheWriteTarget,
  type WorkspaceBundlePlan,
  type WorkspaceBundleRequest,
  type WorkspaceCachePlan
} from './read-plan.js'
export {
  createSourceCacheWriter,
  type SourceCacheBundleStager,
  type SourceCacheWriteOutcome,
  type SourceCacheWriter,
  type SourceCacheStagedWriteRequest,
  type SourceCacheWriteRequest,
  type SourceCacheWriteScope,
  type SourceCacheWriteSkipReason
} from './write-back.js'
export {
  createSkillCachePlanner,
  type SkillCachePlannerDeps,
  type SkillSourceCachePlan,
  type SkillWriteBackIntent
} from './skill-write-back.js'
export { createSourceCacheMetrics, sourceCacheMetrics, type SourceCacheMetrics } from './metrics.js'
export {
  evaluateSourceCacheLifecycle,
  SOURCE_CACHE_LIFECYCLE_DAYS,
  sourceCacheLifecycleRules,
  type SourceCacheBucketLifecycle,
  type SourceCacheLifecycleDocument,
  type SourceCacheLifecycleEvaluation
} from '@agentconnect.md/object-store'
export {
  createSourceCacheSweeper,
  type SourceCacheLifecycleStatus,
  type SourceCacheSweepCounts,
  type SourceCacheSweeper,
  type SourceCacheSweeperDeps,
  type SourceCacheSweepPass,
  type SourceCacheSweepStore
} from './sweep.js'
