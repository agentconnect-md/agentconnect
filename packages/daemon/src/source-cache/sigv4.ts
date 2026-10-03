import { createHash, createHmac } from 'node:crypto'

// A small AWS Signature Version 4 core for S3 (query presigning and header auth), on node:crypto only.

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export interface SigV4Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SigV4Target {
  method: string
  /** `https:` in production; `http:` only for local fixtures. */
  protocol: 'https:' | 'http:'
  /** Host header value, with a port only when it is non-default. */
  host: string
  /** Raw (unencoded) absolute path; each segment is S3-encoded once. */
  path: string
  /** Raw query parameters; an empty string value is a value-less parameter such as `tagging`. */
  query?: Record<string, string>
  /** Headers to sign besides host. */
  headers?: Record<string, string>
  credentials: SigV4Credentials
  region: string
  service?: string
  /** `YYYYMMDDTHHMMSSZ`. */
  datetime: string
}

/** S3's URI encoding: everything but the RFC 3986 unreserved set, as upper-case UTF-8 percent escapes. */
export function s3UriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Encode each path segment once, keeping '/'. */
export function canonicalUri(path: string): string {
  if (!path.startsWith('/')) throw new Error('canonical path must be absolute')
  return path.split('/').map(s3UriEncode).join('/')
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [s3UriEncode(k), s3UriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function normalizedHeaders(headers: Record<string, string>): Array<[string, string]> {
  const out = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase()
    if (out.has(key)) throw new Error(`duplicate header ${key}`)
    out.set(key, String(value).trim().replace(/\s+/g, ' '))
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

const signingKeys = new Map<string, Buffer>()

/** The derived SigV4 signing key, cached per (secret, date, region, service); the cache stays tiny. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const cacheKey = `${sha256Hex(secret)}/${date}/${region}/${service}`
  const cached = signingKeys.get(cacheKey)
  if (cached) return cached
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request')
  if (signingKeys.size >= 16) signingKeys.clear()
  signingKeys.set(cacheKey, key)
  return key
}

/** `YYYYMMDDTHHMMSSZ` for an epoch-millisecond instant. */
export function amzDate(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

interface Signed {
  signature: string
  signedHeaders: string
  canonicalRequest: string
  scope: string
}

function sign(target: SigV4Target, query: Record<string, string>, payloadHash: string): Signed {
  if (!/^\d{8}T\d{6}Z$/.test(target.datetime)) throw new Error('datetime must be YYYYMMDDTHHMMSSZ')
  const service = target.service ?? 's3'
  const date = target.datetime.slice(0, 8)
  const scope = `${date}/${target.region}/${service}/aws4_request`
  const headers = normalizedHeaders({ ...target.headers, host: target.host })
  const signedHeaders = headers.map(([name]) => name).join(';')
  const canonicalRequest = [
    target.method,
    canonicalUri(target.path),
    canonicalQuery(query),
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    payloadHash
  ].join('\n')
  const stringToSign = [SIGV4_ALGORITHM, target.datetime, scope, sha256Hex(canonicalRequest)].join('\n')
  const key = signingKey(target.credentials.secretAccessKey, date, target.region, service)
  return {
    signature: createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex'),
    signedHeaders,
    canonicalRequest,
    scope
  }
}

export interface PresignResult {
  url: string
  signedHeaders: string
  canonicalRequest: string
}

/** A query-string presigned URL; every header in `target.headers` stays a signed HEADER, never hoisted into the query. */
export function presign(target: SigV4Target & { expiresSeconds: number }): PresignResult {
  if (!Number.isInteger(target.expiresSeconds) || target.expiresSeconds < 1 || target.expiresSeconds > 604_800) {
    throw new Error('presign lifetime must be 1s to 7 days')
  }
  const service = target.service ?? 's3'
  const scope = `${target.datetime.slice(0, 8)}/${target.region}/${service}/aws4_request`
  const headerNames = Object.keys({ ...target.headers, host: target.host })
    .map((name) => name.trim().toLowerCase())
    .sort()
  const query: Record<string, string> = {
    ...target.query,
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${target.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': target.datetime,
    'X-Amz-Expires': String(target.expiresSeconds),
    'X-Amz-SignedHeaders': headerNames.join(';'),
    ...(target.credentials.sessionToken ? { 'X-Amz-Security-Token': target.credentials.sessionToken } : {})
  }
  const signed = sign(target, query, UNSIGNED_PAYLOAD)
  const queryString = `${canonicalQuery(query)}&X-Amz-Signature=${signed.signature}`
  return {
    url: `${target.protocol}//${target.host}${canonicalUri(target.path)}?${queryString}`,
    signedHeaders: signed.signedHeaders,
    canonicalRequest: signed.canonicalRequest
  }
}

export interface HeaderSignResult {
  authorization: string
  signedHeaders: string
  canonicalRequest: string
}

/** Header (Authorization) signing over the same canonical core; the caller supplies x-amz-date and x-amz-content-sha256. */
export function signHeaders(target: SigV4Target & { payloadHash: string }): HeaderSignResult {
  const headers = { ...target.headers }
  if (target.credentials.sessionToken) headers['x-amz-security-token'] = target.credentials.sessionToken
  const signed = sign({ ...target, headers }, target.query ?? {}, target.payloadHash)
  return {
    authorization: `${SIGV4_ALGORITHM} Credential=${target.credentials.accessKeyId}/${signed.scope},SignedHeaders=${signed.signedHeaders},Signature=${signed.signature}`,
    signedHeaders: signed.signedHeaders,
    canonicalRequest: signed.canonicalRequest
  }
}
