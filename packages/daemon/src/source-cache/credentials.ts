import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { posix } from 'node:path'
import type { SourceCacheCredentialsConfig } from './config.js'

// Bucket credentials for a pool member (source-cache.md §6 item 4): mounted static keys or STS web identity.

export interface SourceCacheCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Epoch ms; absent for long-lived static keys. */
  expiresAt?: number
}

export interface CredentialsProvider {
  readonly source: 'static' | 'webIdentity'
  /** Credentials that stay valid for at least `minValidityMs`, or a rejection (a Source Cache miss, §12). */
  get(minValidityMs: number): Promise<SourceCacheCredentials>
}

export type ReadTextFile = (path: string) => string

const defaultReadFile: ReadTextFile = (path) => readFileSync(path, 'utf8')
/** How often mounted static keys are re-read, so a Secret rotation is picked up. */
export const STATIC_REREAD_MS = 60_000
/** Quiet period after a failed STS call, so a broken STS is not hammered. */
export const STS_FAILURE_BACKOFF_MS = 10_000
const STS_TIMEOUT_MS = 10_000

export interface StaticCredentialsOptions {
  dir: string
  accessKeyIdKey: string
  secretAccessKeyKey: string
  sessionTokenKey?: string
  readFile?: ReadTextFile
  now?: () => number
}

/** Keys mounted as files (never env, so nothing the daemon spawns inherits them); construction fails fast when absent. */
export function staticCredentials(opts: StaticCredentialsOptions): CredentialsProvider {
  const readFile = opts.readFile ?? defaultReadFile
  const now = opts.now ?? Date.now
  const required = (key: string, label: string): string => {
    let value: string
    try {
      value = readFile(posix.join(opts.dir, key)).trim()
    } catch {
      throw new Error(`Source Cache ${label} file is missing`)
    }
    if (!value) throw new Error(`Source Cache ${label} file is empty`)
    return value
  }
  const optional = (key: string | undefined): string | undefined => {
    if (!key) return undefined
    try {
      return readFile(posix.join(opts.dir, key)).trim() || undefined
    } catch {
      return undefined
    }
  }
  const read = (): SourceCacheCredentials => {
    const sessionToken = optional(opts.sessionTokenKey)
    return {
      accessKeyId: required(opts.accessKeyIdKey, 'access key id'),
      secretAccessKey: required(opts.secretAccessKeyKey, 'secret access key'),
      ...(sessionToken ? { sessionToken } : {})
    }
  }
  let current = read()
  let readAt = now()
  return {
    source: 'static',
    get: async () => {
      if (now() - readAt >= STATIC_REREAD_MS) {
        // A failed re-read keeps the last good keys; the kubelet swaps Secret files atomically.
        try {
          current = read()
        } catch {}
        readAt = now()
      }
      return current
    }
  }
}

export interface WebIdentityOptions {
  region: string
  roleArn?: string
  tokenFile?: string
  stsEndpoint?: string
  sessionName?: string
  durationSeconds: number
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  readFile?: ReadTextFile
  now?: () => number
}

/** STS AssumeRoleWithWebIdentity with a projected ServiceAccount token, cached and refreshed single-flight. */
export function webIdentityCredentials(opts: WebIdentityOptions): CredentialsProvider {
  const env = opts.env ?? process.env
  const roleArn = opts.roleArn || env.AWS_ROLE_ARN?.trim()
  const tokenFile = opts.tokenFile || env.AWS_WEB_IDENTITY_TOKEN_FILE?.trim()
  if (!roleArn) throw new Error('Source Cache web identity needs a role ARN (credentials.roleArn or AWS_ROLE_ARN)')
  if (!tokenFile) {
    throw new Error(
      'Source Cache web identity needs a token file (credentials.tokenFile or AWS_WEB_IDENTITY_TOKEN_FILE)'
    )
  }
  const endpoint = opts.stsEndpoint ?? `https://sts.${opts.region}.amazonaws.com`
  const sessionName = opts.sessionName ?? defaultSessionName(env)
  const fetchImpl = opts.fetch ?? fetch
  const readFile = opts.readFile ?? defaultReadFile
  const now = opts.now ?? Date.now

  let cached: SourceCacheCredentials | undefined
  let inflight: Promise<SourceCacheCredentials> | undefined
  let lastFailureAt: number | undefined

  const sufficient = (creds: SourceCacheCredentials | undefined, minValidityMs: number): boolean =>
    creds !== undefined && (creds.expiresAt === undefined || creds.expiresAt - now() >= minValidityMs)

  const assume = async (): Promise<SourceCacheCredentials> => {
    // Re-read every call: the kubelet rotates the projected token.
    let token: string
    try {
      token = readFile(tokenFile).trim()
    } catch {
      throw new Error('Source Cache web identity token file is unreadable')
    }
    if (!token) throw new Error('Source Cache web identity token file is empty')
    const body = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: '2011-06-15',
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      WebIdentityToken: token,
      DurationSeconds: String(opts.durationSeconds)
    })
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/xml' },
        body: body.toString(),
        signal: AbortSignal.timeout(STS_TIMEOUT_MS)
      })
    } catch (err) {
      throw new Error(`STS AssumeRoleWithWebIdentity request failed: ${(err as Error).name}`)
    }
    const text = await response.text()
    if (!response.ok) {
      const code = /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(text)?.[1] ?? 'unknown'
      throw new Error(`STS AssumeRoleWithWebIdentity failed: HTTP ${response.status} ${code}`)
    }
    return parseStsCredentials(text)
  }

  return {
    source: 'webIdentity',
    get: async (minValidityMs) => {
      if (sufficient(cached, minValidityMs)) return cached!
      if (!inflight) {
        if (lastFailureAt !== undefined && now() - lastFailureAt < STS_FAILURE_BACKOFF_MS) {
          throw new Error('Source Cache credentials unavailable: STS is backing off after a failure')
        }
        const attempt = assume().then(
          (creds) => {
            cached = creds
            lastFailureAt = undefined
            return creds
          },
          (err: unknown) => {
            lastFailureAt = now()
            throw err
          }
        )
        inflight = attempt
        const clear = (): void => {
          if (inflight === attempt) inflight = undefined
        }
        attempt.then(clear, clear)
      }
      try {
        const creds = await inflight
        if (!sufficient(creds, minValidityMs)) {
          // A short-lived answer is a failure for backoff, or every presign would re-call STS.
          lastFailureAt = now()
          throw new Error('STS credentials expire before the requested validity')
        }
        return creds
      } catch (err) {
        if (sufficient(cached, minValidityMs)) return cached!
        throw err
      }
    }
  }
}

function defaultSessionName(env: NodeJS.ProcessEnv): string {
  const who = env.AC_K8S_MEMBER_ID?.trim() || hostname()
  return `agentconnect-source-cache-${who}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64)
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function xmlText(xml: string, tag: string): string | undefined {
  const raw = new RegExp(`<${tag}>([^<]{1,4096})</${tag}>`).exec(xml)?.[1]
  return raw?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!).trim()
}

/** Parse the `<Credentials>` element of an AssumeRoleWithWebIdentity answer. */
export function parseStsCredentials(xml: string): SourceCacheCredentials {
  const block = /<Credentials>([\s\S]*?)<\/Credentials>/.exec(xml)?.[1]
  if (!block) throw new Error('STS answer carries no credentials')
  const accessKeyId = xmlText(block, 'AccessKeyId')
  const secretAccessKey = xmlText(block, 'SecretAccessKey')
  const sessionToken = xmlText(block, 'SessionToken')
  const expiration = xmlText(block, 'Expiration')
  const expiresAt = expiration ? Date.parse(expiration) : NaN
  if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiresAt)) {
    throw new Error('STS answer carries incomplete credentials')
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt }
}

export interface CredentialsDeps {
  region: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  readFile?: ReadTextFile
  now?: () => number
}

/** Build the configured credential source; throws on missing files or identity so a bad deployment fails at boot. */
export function createCredentialsProvider(
  config: SourceCacheCredentialsConfig,
  deps: CredentialsDeps
): CredentialsProvider {
  if (config.source === 'static') {
    return staticCredentials({
      dir: config.dir,
      accessKeyIdKey: config.accessKeyIdKey,
      secretAccessKeyKey: config.secretAccessKeyKey,
      ...(config.sessionTokenKey ? { sessionTokenKey: config.sessionTokenKey } : {}),
      ...(deps.readFile ? { readFile: deps.readFile } : {}),
      ...(deps.now ? { now: deps.now } : {})
    })
  }
  return webIdentityCredentials({
    region: deps.region,
    durationSeconds: config.durationSeconds,
    ...(config.roleArn ? { roleArn: config.roleArn } : {}),
    ...(config.tokenFile ? { tokenFile: config.tokenFile } : {}),
    ...(config.stsEndpoint ? { stsEndpoint: config.stsEndpoint } : {}),
    ...(config.sessionName ? { sessionName: config.sessionName } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.readFile ? { readFile: deps.readFile } : {}),
    ...(deps.now ? { now: deps.now } : {})
  })
}
