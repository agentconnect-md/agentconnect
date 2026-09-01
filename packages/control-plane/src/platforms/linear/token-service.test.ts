/**
 * `LinearTokenService` — token custody (docs/designs/linear-integration.md §4.4, §14 "CP unit").
 *
 * The two properties this suite exists for are the two the design calls out by name, because both
 * are silent when broken: a lost single-flight only shows up as a workspace that mysteriously needs
 * reconnecting under load, and a reply-before-persist only shows up after a crash. Everything runs
 * against a fake Linear whose call log IS the assertion.
 */
import { describe, it, expect } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { OrgId } from '../../domain/ids.js'
import type {
  LinearConnectionIdentity,
  LinearTokenMaterial,
  LinearTokenRecord,
  LinearTokenStore
} from '../../persistence/ports.js'
import { LinearApiClient } from './api.js'
import { LinearTokenService, LINEAR_REFRESH_MARGIN_MS } from './token-service.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const APP = { clientId: 'lin_client_id', clientSecret: 'lin_client_secret', signingSecret: 'lin_signing' }
const IDENTITY: LinearConnectionIdentity = { orgId: ORG, clientId: APP.clientId, organizationId: 'org_9f2c' }
const NOW = Date.parse('2026-03-01T00:00:00.000Z')

class MemoryTokens implements LinearTokenStore {
  readonly rows = new Map<string, LinearTokenRecord>()
  /** Every `put`, in order — the persist-before-reply assertion reads this. */
  readonly writes: LinearTokenMaterial[] = []
  private static key(i: LinearConnectionIdentity) {
    return `${i.orgId} ${i.clientId} ${i.organizationId}`
  }
  get(identity: LinearConnectionIdentity): Promise<LinearTokenRecord | null> {
    return Promise.resolve(this.rows.get(MemoryTokens.key(identity)) ?? null)
  }
  put(identity: LinearConnectionIdentity, material: LinearTokenMaterial): Promise<void> {
    this.writes.push(material)
    this.rows.set(MemoryTokens.key(identity), { ...identity, ...material, updatedAt: new Date(NOW) })
    return Promise.resolve()
  }
  delete(identity: LinearConnectionIdentity): Promise<void> {
    this.rows.delete(MemoryTokens.key(identity))
    return Promise.resolve()
  }
  listOrphans(): Promise<[]> {
    return Promise.resolve([])
  }
  deleteIfUnchanged(): Promise<null> {
    return Promise.resolve(null)
  }
}

type Answer = { status: number; body: unknown }

/** A scriptable Linear whose call log IS the assertion. `hold` keeps every in-flight call parked
 *  until it is released, which is how the single-flight test gets genuine concurrency. */
class FakeLinear {
  readonly calls: { url: string; body: string }[] = []
  private script: () => Answer = () => ({ status: 200, body: {} })
  private gate: Promise<void> | undefined
  private open: (() => void) | undefined

  reply(next: () => Answer): void {
    this.script = next
  }

  hold(): void {
    this.gate = new Promise<void>((resolve) => (this.open = resolve))
  }

  release(): void {
    this.open?.()
    this.gate = undefined
  }

  readonly fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url, body: String(init?.body ?? '') })
    const answer = this.script()
    if (this.gate) await this.gate
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' }
    })
  }
}

function build(clock = new FakeClock(NOW)) {
  const tokens = new MemoryTokens()
  const linear = new FakeLinear()
  const api = new LinearApiClient({ fetchImpl: linear.fetchImpl, clock })
  const service = new LinearTokenService({ app: APP, tokens, api, clock })
  return { tokens, linear, service, clock }
}

/** A stored grant whose access token expires `inMs` from now. */
async function seed(tokens: MemoryTokens, inMs: number, refreshToken: string | null = 'refresh_1') {
  await tokens.put(IDENTITY, { accessToken: 'access_1', refreshToken, expiresAt: new Date(NOW + inMs) })
  tokens.writes.length = 0
}

const rotated = (n: number) => ({
  status: 200,
  body: { access_token: `access_${n}`, refresh_token: `refresh_${n}`, expires_in: 86400 }
})

describe('accessToken — refresh only when the stored grant is near expiry', () => {
  it('uses a fresh token as-is, without touching Linear', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, LINEAR_REFRESH_MARGIN_MS + 60_000)
    expect(await service.accessToken(IDENTITY)).toMatchObject({ ok: true, accessToken: 'access_1' })
    expect(linear.calls).toHaveLength(0)
  })

  it('refreshes inside the safety margin and hands back the rotated token', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, LINEAR_REFRESH_MARGIN_MS - 60_000)
    linear.reply(() => rotated(2))

    expect(await service.accessToken(IDENTITY)).toMatchObject({ ok: true, accessToken: 'access_2' })
    expect(linear.calls).toHaveLength(1)
    expect(linear.calls[0]!.body).toContain('grant_type=refresh_token')
    // The rotated REFRESH half is persisted too — Linear invalidates the old one.
    expect(await tokens.get(IDENTITY)).toMatchObject({ accessToken: 'access_2', refreshToken: 'refresh_2' })
  })

  it('persists the rotated pair BEFORE replying', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => rotated(2))

    const resolution = await service.accessToken(IDENTITY)
    // A crash between the reply and the write would strand the workspace on a spent refresh token,
    // so the write has to have happened by the time any caller can observe the new access token.
    expect(tokens.writes).toEqual([expect.objectContaining({ accessToken: 'access_2', refreshToken: 'refresh_2' })])
    expect(resolution).toMatchObject({ ok: true, accessToken: 'access_2' })
  })

  it('answers not_connected for an identity with no grant', async () => {
    const { service, linear } = build()
    expect(await service.accessToken(IDENTITY)).toEqual({ ok: false, reason: 'not_connected' })
    expect(linear.calls).toHaveLength(0)
  })

  it('answers reconnect_required when the grant carries nothing to rotate with', async () => {
    const { tokens, service, linear } = build()
    await seed(tokens, 0, null)
    expect(await service.accessToken(IDENTITY)).toEqual({ ok: false, reason: 'reconnect_required' })
    expect(linear.calls).toHaveLength(0)
  })
})

describe('rotate-and-retry — a rejected rotate may just mean someone else rotated first', () => {
  it('reloads once and uses the pair a concurrent writer persisted', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    // Linear rejects the refresh (already spent), and the row now holds the winner's fresh pair.
    linear.reply(() => {
      void tokens.put(IDENTITY, {
        accessToken: 'access_peer',
        refreshToken: 'refresh_peer',
        expiresAt: new Date(NOW + 86_400_000)
      })
      return { status: 400, body: { error: 'invalid_grant' } }
    })

    expect(await service.accessToken(IDENTITY)).toMatchObject({ ok: true, accessToken: 'access_peer' })
    // Exactly one upstream attempt: the retry is a RELOAD, not a second rotate.
    expect(linear.calls).toHaveLength(1)
  })

  it('flips to reconnect_required when the reload finds nothing fresher', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => ({ status: 400, body: { error: 'invalid_grant' } }))
    expect(await service.accessToken(IDENTITY)).toEqual({ ok: false, reason: 'reconnect_required' })
  })

  it('never spends the retry — or the workspace’s state — on an unreachable Linear', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => ({ status: 502, body: {} }))
    expect(await service.accessToken(IDENTITY)).toEqual({ ok: false, reason: 'unreachable' })
    // A blip is not proof the grant is dead: the stored pair is untouched and a later call retries.
    expect(await tokens.get(IDENTITY)).toMatchObject({ accessToken: 'access_1', refreshToken: 'refresh_1' })
  })

  it('recovers on the next call once Linear comes back', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => ({ status: 503, body: {} }))
    expect(await service.accessToken(IDENTITY)).toEqual({ ok: false, reason: 'unreachable' })
    linear.reply(() => rotated(2))
    expect(await service.accessToken(IDENTITY)).toMatchObject({ ok: true, accessToken: 'access_2' })
    expect(linear.calls).toHaveLength(2)
  })
})

describe('single-flight — concurrent renewals collapse to one rotate', () => {
  it('makes ONE upstream call for N concurrent requests and gives them all the same token', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => rotated(2))
    // Park the rotate so all five callers are genuinely in flight together — without the hold, each
    // would complete before the next started and the test would pass with no single-flight at all.
    linear.hold()

    const all = Promise.all([1, 2, 3, 4, 5].map(() => service.accessToken(IDENTITY)))
    linear.release()
    const results = await all

    expect(linear.calls).toHaveLength(1)
    for (const r of results) expect(r).toMatchObject({ ok: true, accessToken: 'access_2' })
    // And exactly one durable write, so no rotation is silently overwritten by a stale one.
    expect(tokens.writes).toHaveLength(1)
  })

  it('lets a LATER renewal run once the flight is over', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 0)
    linear.reply(() => rotated(2))
    await service.accessToken(IDENTITY)
    // Rotated forward, but still inside the margin, so the next call refreshes again.
    await tokens.put(IDENTITY, {
      accessToken: 'access_2',
      refreshToken: 'refresh_2',
      expiresAt: new Date(NOW + 1000)
    })
    linear.reply(() => rotated(3))
    expect(await service.accessToken(IDENTITY)).toMatchObject({ ok: true, accessToken: 'access_3' })
    expect(linear.calls).toHaveLength(2)
  })
})

describe('exchange and revoke', () => {
  it('exchanges an authorization code into a grant with an absolute expiry', async () => {
    const { linear, service } = build()
    linear.reply(() => ({ status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }))
    const res = await service.exchangeCode({ code: 'the-code', redirectUri: 'https://cp.example.test/v1/cb' })
    expect(res.ok).toBe(true)
    expect(res.ok && res.result.expiresAt.toISOString()).toBe(new Date(NOW + 3_600_000).toISOString())
    expect(linear.calls[0]!.body).toContain('grant_type=authorization_code')
  })

  it('refuses a token response that carries no access token', async () => {
    const { linear, service } = build()
    linear.reply(() => ({ status: 200, body: { refresh_token: 'r' } }))
    expect(await service.exchangeCode({ code: 'c', redirectUri: 'https://cp.example.test/v1/cb' })).toMatchObject({
      ok: false,
      error: 'rejected'
    })
  })

  it('revokes the stored access token, and answers false rather than throwing when it cannot', async () => {
    const { tokens, linear, service } = build()
    await seed(tokens, 86_400_000)
    linear.reply(() => ({ status: 200, body: {} }))
    expect(await service.revoke(IDENTITY)).toBe(true)
    expect(linear.calls.at(-1)!.url).toContain('/oauth/revoke')

    linear.reply(() => ({ status: 400, body: {} }))
    expect(await service.revoke(IDENTITY)).toBe(false)
    // Nothing to revoke is not an error either — the sweeper races the disconnect edge by design.
    await tokens.delete(IDENTITY)
    expect(await service.revoke(IDENTITY)).toBe(false)
  })
})
