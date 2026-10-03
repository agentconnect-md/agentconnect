import { loadSourceCacheConfig, SOURCE_CACHE_ENV, sourceCacheEndpoint, type SourceCacheConfig } from './config.js'
import { createCredentialsProvider, type ReadTextFile } from './credentials.js'
import { createObjectClient, type SourceCacheObjectClient } from './object-client.js'
import { addressFor, createPresigner, type SourceCachePresigner } from './presigner.js'

// Pool-member Source Cache wiring (source-cache.md §12): absent config means no signer, no I/O, no state.

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
  createSourceCacheReadPlanner,
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
  type SourceCacheWriteRequest,
  type SourceCacheWriteSkipReason
} from './write-back.js'
export { createSourceCacheMetrics, sourceCacheMetrics, type SourceCacheMetrics } from './metrics.js'
export type { SourceCacheBucketLifecycle, SourceCacheObjectClient } from './object-client.js'
export {
  evaluateSourceCacheLifecycle,
  SOURCE_CACHE_LIFECYCLE_DAYS,
  sourceCacheLifecycleRules,
  type SourceCacheLifecycleDocument,
  type SourceCacheLifecycleEvaluation
} from './lifecycle.js'
export {
  createSourceCacheSweeper,
  type SourceCacheLifecycleStatus,
  type SourceCacheSweepCounts,
  type SourceCacheSweeper,
  type SourceCacheSweeperDeps,
  type SourceCacheSweepPass,
  type SourceCacheSweepStore
} from './sweep.js'
