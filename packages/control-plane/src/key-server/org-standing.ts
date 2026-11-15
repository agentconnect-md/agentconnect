// The key server's answer to "may this org start Cloud compute now" (key-server.md §2.3), cached briefly per org.
import { readFile } from 'node:fs/promises'
import {
  KEY_SERVER_AUTH_HEADER,
  KEY_SERVER_ORG_STANDING_PATH,
  KeyServerErrorBody,
  OrgStandingResponse,
  type OrgStandingRequest
} from '@agentconnect.md/protocol'
import type { Clock } from '../domain/clock.js'

/** Allowed, refused by the issuer (`suspended`, with its own status and words), or not known right now. */
export type OrgStandingVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'suspended'; status: number; message: string }
  | { allowed: false; reason: 'unavailable'; message: string; status?: number }

/** The seam every Cloud-compute start asks; absent from the graph means no standing gate at all. */
export interface OrgStanding {
  check(orgId: string): Promise<OrgStandingVerdict>
}

/** Why a Cloud-compute start is refused: the issuer's own words, or a fixed line when nobody could say. */
export type StandingRefusal = { code: 'org_suspended' | 'standing_unavailable'; message: string }

const UNAVAILABLE_MESSAGE = 'cannot confirm this organization may start Cloud compute right now; try again shortly'

/** The refusal a Cloud-compute start answers with, or null when it may go ahead (always, with no gate configured). */
export async function standingRefusal(
  standing: OrgStanding | undefined,
  orgId: string,
  log?: { warn(obj: unknown, msg?: string): void }
): Promise<StandingRefusal | null> {
  if (!standing) return null
  const verdict = await standing.check(orgId)
  if (verdict.allowed) return null
  if (verdict.reason === 'suspended') return { code: 'org_suspended', message: verdict.message }
  log?.warn({ orgId, reason: verdict.message }, 'org standing unknown; refusing a Cloud-compute start')
  return { code: 'standing_unavailable', message: UNAVAILABLE_MESSAGE }
}

/** How long an answer, allowed or suspended, stands before the key server is asked again. */
export const ORG_STANDING_TTL_MS = 30_000
const DEFAULT_TIMEOUT_MS = 5_000
// Entries past their TTL are swept once the cache holds this many orgs.
const SWEEP_AT = 1_024
const SUSPENDED_FALLBACK = 'this organization cannot start Cloud compute right now'

export interface KeyServerOrgStandingOpts {
  tokenPath?: string
  clock: Clock
  fetch?: typeof globalThis.fetch
  ttlMs?: number
  timeoutMs?: number
}

export class KeyServerOrgStanding implements OrgStanding {
  private readonly baseUrl: URL
  private readonly cache = new Map<string, { verdict: OrgStandingVerdict; until: number }>()
  private readonly inflight = new Map<string, Promise<OrgStandingVerdict>>()

  constructor(
    address: string,
    private readonly opts: KeyServerOrgStandingOpts
  ) {
    this.baseUrl = new URL(address)
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.protocol !== 'http:') {
      throw new Error(`key-server address must be http or https, got ${this.baseUrl.protocol}`)
    }
    if (this.baseUrl.username || this.baseUrl.password) throw new Error('key-server URL must not contain credentials')
  }

  async check(orgId: string): Promise<OrgStandingVerdict> {
    const now = this.opts.clock.now()
    const cached = this.cache.get(orgId)
    if (cached && cached.until > now) return cached.verdict
    const running = this.inflight.get(orgId)
    if (running) return await running
    const asked = this.ask(orgId).finally(() => this.inflight.delete(orgId))
    this.inflight.set(orgId, asked)
    const verdict = await asked
    // An unanswered question is asked again next time; a definite answer stands for one TTL.
    if (verdict.allowed || verdict.reason === 'suspended') this.remember(orgId, verdict)
    else this.cache.delete(orgId)
    return verdict
  }

  private remember(orgId: string, verdict: OrgStandingVerdict): void {
    const now = this.opts.clock.now()
    if (this.cache.size >= SWEEP_AT) for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k)
    this.cache.set(orgId, { verdict, until: now + (this.opts.ttlMs ?? ORG_STANDING_TTL_MS) })
  }

  private async token(): Promise<string | undefined> {
    if (!this.opts.tokenPath) return undefined
    const token = (await readFile(this.opts.tokenPath, 'utf8')).trim()
    if (!token) throw new Error('key-server token file is empty')
    return token
  }

  private async ask(orgId: string): Promise<OrgStandingVerdict> {
    const unavailable = (message: string, status?: number): OrgStandingVerdict => ({
      allowed: false,
      reason: 'unavailable',
      message,
      ...(status !== undefined ? { status } : {})
    })
    let response: Response
    try {
      const token = await this.token()
      const body: OrgStandingRequest = { orgId }
      response = await (this.opts.fetch ?? globalThis.fetch)(new URL(KEY_SERVER_ORG_STANDING_PATH, this.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { [KEY_SERVER_AUTH_HEADER]: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
    } catch (error) {
      return unavailable(`key server unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      return unavailable(`key server returned non-JSON HTTP ${response.status}`, response.status)
    }
    if (response.ok) {
      return OrgStandingResponse.safeParse(json).success
        ? { allowed: true }
        : unavailable('key server returned an invalid OrgStanding response', response.status)
    }
    const refusal = KeyServerErrorBody.safeParse(json)
    if (refusal.success && refusal.data.error.code === 'org_suspended') {
      return {
        allowed: false,
        reason: 'suspended',
        status: response.status,
        message: refusal.data.error.message ?? SUSPENDED_FALLBACK
      }
    }
    // Any other refusal is the key server unable to say, which fails closed like an outage.
    const code = refusal.success ? ` (${refusal.data.error.code})` : ''
    return unavailable(`key server answered HTTP ${response.status}${code}`, response.status)
  }
}
