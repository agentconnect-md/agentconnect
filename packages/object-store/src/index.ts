// S3-compatible object store primitives shared by the daemon's Source Cache and the control plane's file transfer.
export { addressFor, type BucketAddressing } from './address.js'
export {
  bucketEndpoint,
  BucketCredentialsSchema,
  Bucket,
  ByteQuantity,
  checkSessionDuration,
  DurationSeconds,
  Endpoint,
  parseEnvDocument,
  Prefix,
  Region,
  S3_SINGLE_PUT_MAX_BYTES,
  SOURCE_CACHE_GRACE_SECONDS,
  sessionSecondsFor,
  StaticCredentials,
  STS_MAX_SESSION_SECONDS,
  WebIdentityCredentials,
  withSessionDuration,
  type BucketCredentialsConfig,
  type BucketLocation
} from './config.js'
export {
  createCredentialsProvider,
  parseStsCredentials,
  staticCredentials,
  STATIC_REREAD_MS,
  STS_FAILURE_BACKOFF_MS,
  webIdentityCredentials,
  type BucketCredentials,
  type CredentialsDeps,
  type CredentialsProvider,
  type ReadTextFile,
  type StaticCredentialsOptions,
  type WebIdentityOptions
} from './credentials.js'
export {
  evaluateSourceCacheLifecycle,
  SOURCE_CACHE_LIFECYCLE_DAYS,
  sourceCacheLifecycleRules,
  sourceCacheSrcPrefix,
  type SourceCacheLifecycleDocument,
  type SourceCacheLifecycleEvaluation,
  type SourceCacheLifecycleTagValue
} from './lifecycle.js'
export {
  createObjectClient,
  SourceCacheObjectError,
  type ObjectClientOptions,
  type SourceCacheBucketLifecycle,
  type SourceCacheLifecycleTag,
  type SourceCacheObjectClient,
  type SourceCacheObjectHead
} from './object-client.js'
export {
  amzDate,
  canonicalQuery,
  canonicalUri,
  presign,
  s3UriEncode,
  sha256Hex,
  SIGV4_ALGORITHM,
  signHeaders,
  signingKey,
  UNSIGNED_PAYLOAD,
  type HeaderSignResult,
  type PresignResult,
  type SigV4Credentials,
  type SigV4Target
} from './sigv4.js'
