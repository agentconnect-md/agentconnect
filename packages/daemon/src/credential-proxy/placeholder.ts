// The credential an agent's environment holds (github-app-git-credentials.md, Phase 2): a sealed placeholder the proxy verifies offline and exchanges for a code-host token or a provider API key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Every placeholder starts with this, so the proxy tells it from a credential the agent brought itself. */
export const PLACEHOLDER_PREFIX = 'acph1_'

/** What a placeholder stands in for: a code-host token, or one provider API key slot. */
export type PlaceholderKind = 'codehost' | 'provider'

/** What a placeholder vouches for: the agent it was issued to, the hosts it may be presented to, and its kind (a code host when unset). */
export interface PlaceholderClaims {
  agentId: string
  hosts: string[]
  kind?: PlaceholderKind
  /** The provider slot a `provider` placeholder stands in for, such as `org:anthropic`. */
  slot?: string
}

/** Claims as opened: the kind always set, a placeholder sealed before kinds existed reading as a code host's. */
export type OpenedClaims = PlaceholderClaims & { kind: PlaceholderKind }

const KEY_BYTES = 32

/** The daemon's sealing key, created once with mode 0600 and kept across restarts so a running runtime's placeholder stays valid. */
export function loadPlaceholderKey(file: string): Buffer {
  if (existsSync(file)) {
    const key = readFileSync(file)
    if (key.length !== KEY_BYTES) throw new Error(`credential proxy key ${file} is not ${KEY_BYTES} bytes`)
    return key
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const key = randomBytes(KEY_BYTES)
  const temporary = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(temporary, key, { mode: 0o600, flag: 'wx' })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
  return key
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(`${PLACEHOLDER_PREFIX}${body}`).digest()
}

/** Seal claims into a placeholder: prefix, base64url claims, `.`, base64url MAC. */
export function sealPlaceholder(key: Buffer, claims: PlaceholderClaims): string {
  const kind = claims.kind ?? 'codehost'
  if (kind === 'provider' && !claims.slot) throw new Error('a provider placeholder needs its slot')
  const sealed = { a: claims.agentId, h: claims.hosts, k: kind, ...(kind === 'provider' ? { p: claims.slot } : {}) }
  const body = Buffer.from(JSON.stringify(sealed)).toString('base64url')
  return `${PLACEHOLDER_PREFIX}${body}.${mac(key, body).toString('base64url')}`
}

/** The claims a placeholder carries, or undefined for anything this daemon did not seal; never throws. */
export function openPlaceholder(key: Buffer, value: string): OpenedClaims | undefined {
  if (!value.startsWith(PLACEHOLDER_PREFIX)) return undefined
  const [body, tag, ...rest] = value.slice(PLACEHOLDER_PREFIX.length).split('.')
  if (!body || !tag || rest.length > 0) return undefined
  const expected = mac(key, body)
  const presented = Buffer.from(tag, 'base64url')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      a?: unknown
      h?: unknown
      k?: unknown
      p?: unknown
    }
    if (typeof parsed.a !== 'string' || !Array.isArray(parsed.h)) return undefined
    const hosts = parsed.h.filter((host): host is string => typeof host === 'string')
    if (parsed.k === undefined || parsed.k === 'codehost') return { agentId: parsed.a, hosts, kind: 'codehost' }
    if (parsed.k !== 'provider' || typeof parsed.p !== 'string' || parsed.p === '') return undefined
    return { agentId: parsed.a, hosts, kind: 'provider', slot: parsed.p }
  } catch {
    return undefined
  }
}

/** Whether a value looks like one of ours, sealed or not, so a forged one is refused rather than forwarded. */
export function looksLikePlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX)
}
