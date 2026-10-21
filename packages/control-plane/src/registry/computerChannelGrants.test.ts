import { describe, expect, it, vi } from 'vitest'
import {
  ComputerPolicySchema,
  readComputerChannelToken,
  signComputerChannelToken,
  verifyComputerChannelToken
} from '@agentconnect.md/protocol'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { ComputerId, OrgId } from '../domain/ids.js'
import type { ComputerRecord } from '../persistence/ports.js'
import { ComputerChannelGrants, COMPUTER_CHANNEL_TOKEN_TTL_MS } from './computerChannelGrants.js'
import { ComputerChannelKeys } from './computerChannelKeys.js'

const ORG = OrgId('org_1')
const CID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const T0 = 1_760_000_100_000
const relay = { relayId: '11111111-1111-4111-8111-111111111111', url: 'wss://relay-0.example.com/rd/ws' }

function setup(over: Partial<ComputerRecord> = {}, policy: Record<string, unknown> = {}, keyDeliveryMs = 0) {
  const clock = new FakeClock(T0)
  const keys = new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300, keyDeliveryMs)
  const record = {
    id: ComputerId(CID),
    orgId: ORG,
    name: 'Desk',
    ownerUserId: 'user_owner',
    status: 'online',
    lastSeenAt: new Date(T0 - 1000),
    policy: ComputerPolicySchema.parse(policy),
    agentAccess: { mode: 'selected', agents: [AGENT] },
    ...over
  } as unknown as ComputerRecord
  const repo = {
    get: vi.fn(async () => record),
    getUnscoped: vi.fn(async () => record),
    liveKeyId: vi.fn(async (): Promise<string | null> => 'key_1')
  }
  const grants = new ComputerChannelGrants(repo, keys, clock, { staleAfterMs: 45_000, relays: async () => [relay] })
  return { clock, keys, repo, grants }
}

const who = { agentId: AGENT, sessionId: 'sess-1', daemonId: DAEMON }

describe('ComputerChannelGrants', () => {
  it('names the Computer, its owner and its approval policy for the approval cards', async () => {
    const policy = { approvals: { launchApp: 'session', submitLikeKeys: false } }
    const result = await setup({}, policy).grants.grant(ORG, CID, who)
    expect(result).toMatchObject({
      granted: true,
      name: 'Desk',
      ownerUserId: 'user_owner',
      approvals: { firstInputPerSession: true, launchApp: 'session', submitLikeKeys: false }
    })
  })

  it('issues a session token the desktop verifies with its current channel key', async () => {
    const { grants, keys } = setup()
    const result = await grants.grant(ORG, CID, who)
    expect(result).toMatchObject({ granted: true, mode: 'control', relays: [relay] })
    if (!result.granted) throw new Error('refused')
    // The desktop holds the key the CP sent it on its channel; it verifies the token with nothing else.
    const held = keys.current(CID, 'key_1', T0)
    const claims = verifyComputerChannelToken(result.token, {
      aud: 'mcp',
      computerId: CID,
      key: (kid) => (kid === held.keyId ? Buffer.from(held.key, 'base64url') : undefined),
      now: T0 + 1000
    })
    expect(claims).toMatchObject({ ses: 'sess-1', agt: AGENT, dmn: DAEMON, mode: 'control' })
    expect(Date.parse(result.expiresAt) - T0).toBeLessThanOrEqual(COMPUTER_CHANNEL_TOKEN_TTL_MS)
  })

  it('never outlives the key that signed it', async () => {
    const { repo, keys, clock } = setup({ lastSeenAt: new Date(T0 + 100_000) })
    // A token lifetime longer than the key has left: the key's expiry wins.
    const grants = new ComputerChannelGrants(repo, keys, clock, {
      staleAfterMs: 45_000,
      relays: async () => [],
      tokenTtlMs: 290_000
    })
    clock.advance(100_000)
    const result = await grants.grant(ORG, CID, who)
    if (!result.granted) throw new Error('refused')
    const signer = keys.current(CID, 'key_1', clock.now())
    expect(readComputerChannelToken(result.token)?.kid).toBe(signer.keyId)
    expect(result.expiresAt).toBe(signer.expiresAt)
  })

  it('signs just after a key window opens with a key the desktop already holds', async () => {
    // T0 opens a key window; the desktop's last heartbeat came before it, so it holds only the previous window's key.
    const { grants, keys, clock, repo } = setup({ lastSeenAt: new Date(T0 - 5_000) }, {}, 50_000)
    const record = await repo.get()
    const sent = [keys.current(CID, 'key_1', T0 - 1)]
    const verify = (token: string, now: number) =>
      verifyComputerChannelToken(token, {
        aud: 'mcp',
        computerId: CID,
        key: (kid) => {
          const held = sent.find((credential) => credential.keyId === kid)
          return held ? Buffer.from(held.key, 'base64url') : undefined
        },
        now
      })
    clock.advance(1_000)
    const early = await grants.grant(ORG, CID, who)
    if (!early.granted) throw new Error('refused')
    expect(verify(early.token, clock.now())).toMatchObject({ ses: 'sess-1' })
    expect(Date.parse(early.expiresAt)).toBeLessThanOrEqual(Date.parse(sent[0]!.expiresAt))
    // Past the delivery lag the desktop has had a heartbeat, and with it the newest key.
    sent.push(keys.current(CID, 'key_1', T0))
    clock.advance(59_000)
    record.lastSeenAt = new Date(clock.now() - 5_000)
    const later = await grants.grant(ORG, CID, who)
    if (!later.granted) throw new Error('refused')
    expect(readComputerChannelToken(later.token)?.kid).toBe(String(T0))
    expect(verify(later.token, clock.now())).toMatchObject({ ses: 'sess-1' })
  })

  it('carries a view grant into the token', async () => {
    const { grants } = setup({}, { agentMode: 'view' })
    const result = await grants.grant(ORG, CID, who)
    expect(result).toMatchObject({ granted: true, mode: 'view' })
    if (result.granted) expect(readComputerChannelToken(result.token)?.mode).toBe('view')
  })

  it('refuses an ungranted agent, an offline or revoked Computer, and one with no live key', async () => {
    const none: Partial<ComputerRecord> = { agentAccess: { mode: 'none', agents: [] } }
    expect(await setup(none).grants.grant(ORG, CID, who)).toMatchObject({ code: 'denied' })
    const all: Partial<ComputerRecord> = { agentAccess: { mode: 'all', agents: [] } }
    expect(await setup(all).grants.grant(ORG, CID, who)).toMatchObject({ granted: true })
    expect(await setup({ lastSeenAt: new Date(T0 - 60_000) }).grants.grant(ORG, CID, who)).toMatchObject({
      code: 'unavailable'
    })
    expect(await setup({ status: 'revoked' }).grants.grant(ORG, CID, who)).toMatchObject({ code: 'unavailable' })
    const keyless = setup()
    keyless.repo.liveKeyId.mockResolvedValue(null)
    expect(await keyless.grants.grant(ORG, CID, who)).toMatchObject({ code: 'unavailable' })
  })

  it("verifies a relay's hello token against the Computer's live key and nothing else", async () => {
    const { grants, keys } = setup()
    const held = keys.current(CID, 'key_1', T0)
    const sign = (claims: Record<string, unknown>, key = Buffer.from(held.key, 'base64url')) =>
      signComputerChannelToken(
        { aud: 'relay', cmp: CID, kid: held.keyId, iat: T0, exp: T0 + 60_000, ...claims } as never,
        key
      )
    expect(await grants.verifyRelayToken(sign({}), CID)).toEqual({ ok: true, computerId: CID, orgId: ORG })
    expect(await grants.verifyRelayToken(sign({}), 'dddddddd-cccc-4ccc-8ccc-cccccccccccc')).toMatchObject({ ok: false })
    expect(await grants.verifyRelayToken(sign({}, Buffer.alloc(32)), CID)).toMatchObject({ ok: false })
    // An mcp token is not a relay credential.
    const mcp = await grants.grant(ORG, CID, who)
    if (mcp.granted) expect(await grants.verifyRelayToken(mcp.token, CID)).toMatchObject({ ok: false })
    const revoked = setup({ status: 'revoked' })
    expect(await revoked.grants.verifyRelayToken(sign({}), CID)).toMatchObject({ ok: false })
  })
})

describe('ComputerChannelGrants.grantViewer', () => {
  const turn = { urls: ['turn:turn.example.com:3478'], secret: 'turn-shared-secret-0123', ttlSec: 3600 }
  const viewer = (over: Partial<ComputerRecord> = {}, opts: { relays?: string[]; withTurn?: boolean } = {}) => {
    const { repo, keys, clock } = setup(over)
    const grants = new ComputerChannelGrants(repo, keys, clock, {
      staleAfterMs: 45_000,
      relays: async () => [relay],
      viewerRelays: async () => opts.relays ?? ['https://relay.example.com', 'https://relay.example.com', relay.url],
      ...(opts.withTurn ? { turn } : {})
    })
    return { grants, keys }
  }

  it('signs a view token with the member and mode, names each relay once, and verifies on the desktop', async () => {
    const { grants, keys } = viewer({}, { withTurn: true })
    const result = await grants.grantViewer(ORG, CID, { userId: 'user_owner', mode: 'control' })
    if (!result.granted) throw new Error('refused')
    expect(result.relays).toEqual(['https://relay.example.com', relay.url])
    expect(result.mode).toBe('control')
    const held = keys.current(CID, 'key_1', T0)
    const claims = verifyComputerChannelToken(result.token, {
      aud: 'view',
      computerId: CID,
      key: (kid) => (kid === held.keyId ? Buffer.from(held.key, 'base64url') : undefined),
      now: T0 + 1000
    })
    expect(claims).toMatchObject({ aud: 'view', usr: 'user_owner', mode: 'control' })
    // The desktop and the browser get their own TURN usernames from the same secret.
    expect(claims?.ice?.[0]?.username).toBe(`${T0 / 1000 + 3600}:computer-${CID}`)
    expect(result.iceServers).toEqual([
      expect.objectContaining({ urls: turn.urls, username: `${T0 / 1000 + 3600}:viewer-user_owner` })
    ])
    expect(Date.parse(result.expiresAt) - T0).toBeLessThanOrEqual(120_000)
    expect(result.expiresInMs).toBe(Date.parse(result.expiresAt) - T0)
  })

  it('carries no TURN without a configuration', async () => {
    const result = await viewer().grants.grantViewer(ORG, CID, { userId: 'u', mode: 'view' })
    if (!result.granted) throw new Error('refused')
    expect(result.iceServers).toEqual([])
    expect(readComputerChannelToken(result.token)?.ice).toBeUndefined()
  })

  it('refuses an offline or revoked Computer, and a deployment without a relay', async () => {
    expect(
      await viewer({ lastSeenAt: new Date(T0 - 60_000) }).grants.grantViewer(ORG, CID, { userId: 'u', mode: 'view' })
    ).toMatchObject({ granted: false, code: 'unavailable' })
    expect(
      await viewer({ status: 'revoked' } as Partial<ComputerRecord>).grants.grantViewer(ORG, CID, {
        userId: 'u',
        mode: 'view'
      })
    ).toMatchObject({ granted: false, code: 'unavailable' })
    expect(await viewer({}, { relays: [] }).grants.grantViewer(ORG, CID, { userId: 'u', mode: 'view' })).toMatchObject({
      granted: false,
      code: 'no_relay'
    })
  })
})
