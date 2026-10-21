import { createHmac } from 'node:crypto'
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
import { ComputerChannelGrants, COMPUTER_CHANNEL_TOKEN_TTL_MS, rendezvous } from './computerChannelGrants.js'
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
    kind: 'self-hosted',
    capabilities: { viewer: true, viewerStun: true },
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
  const relaySecret = 'r'.repeat(43)
  const relayTurn = [
    ['turn:turn-0.example.com:3478?transport=udp', 'turns:turn-0.example.com:443?transport=tcp'],
    ['turn:turn-1.example.com:3478?transport=udp'],
    ['turn:turn-2.example.com:3478?transport=udp']
  ]
  const stun = ['stun:stun-0.example.com:3478', 'stun:stun-1.example.com:3478', 'stun:stun-2.example.com:3478']
  const viewer = (
    over: Partial<ComputerRecord> = {},
    opts: { relays?: string[]; withTurn?: boolean; relayTurn?: string[][]; policy?: Record<string, unknown> } = {}
  ) => {
    const { repo, keys, clock } = setup(over, opts.policy)
    const grants = new ComputerChannelGrants(repo, keys, clock, {
      staleAfterMs: 45_000,
      relays: async () => [relay],
      viewerRelays: async () => opts.relays ?? ['https://relay.example.com', 'https://relay.example.com', relay.url],
      ...(opts.withTurn ? { turn } : {}),
      ...(opts.relayTurn
        ? { relayTurn: { secret: relaySecret, ttlSec: 21_600, servers: async () => opts.relayTurn! } }
        : {}),
      stunUrls: async () => stun
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

  it('names the relays’ own TURN servers to both peers, in the same order, when no external TURN is configured', async () => {
    const result = await viewer({}, { relayTurn }).grants.grantViewer(ORG, CID, { userId: 'user_owner', mode: 'view' })
    if (!result.granted) throw new Error('refused')
    const username = `${T0 / 1000 + 21_600}:viewer-user_owner`
    const chosen = rendezvous(relayTurn, CID).slice(0, 2)
    expect(result.iceServers).toEqual([
      { urls: chosen[0], username, credential: createHmac('sha1', relaySecret).update(username).digest('base64') },
      expect.objectContaining({ urls: chosen[1], username })
    ])
    const ice = readComputerChannelToken(result.token)?.ice
    expect(ice?.map((server) => server.urls)).toEqual(chosen)
    expect(ice?.[0]?.username).toBe(`${T0 / 1000 + 21_600}:computer-${CID}`)
    // An external TURN is the operator's explicit choice and takes precedence.
    const external = await viewer({}, { relayTurn, withTurn: true }).grants.grantViewer(ORG, CID, {
      userId: 'user_owner',
      mode: 'view'
    })
    if (!external.granted) throw new Error('refused')
    expect(external.iceServers.map((server) => server.urls)).toEqual([turn.urls])
  })

  it('spreads Computers across all the TURN relays, each Computer keeping a stable pick', () => {
    const relays = Array.from({ length: 6 }, (_, i) => [`turn:turn-${i}.example.com:3478?transport=udp`])
    const picks = Array.from({ length: 60 }, (_, i) => rendezvous(relays, `cmp_${i}`).slice(0, 2))
    expect(new Set(picks.map((pick) => pick[0]![0])).size).toBeGreaterThan(2)
    expect(new Set(picks.flat().map((urls) => urls[0])).size).toBe(6)
    expect(rendezvous([...relays].reverse(), 'cmp_7')).toEqual(rendezvous(relays, 'cmp_7'))
    // A relay leaving moves only the Computers that had picked it.
    const without = relays.slice(1)
    for (let i = 0; i < 60; i++) {
      const before = rendezvous(relays, `cmp_${i}`)[0]!
      if (before !== relays[0]) expect(rendezvous(without, `cmp_${i}`)[0]).toEqual(before)
    }
  })

  it('starts a managed computer’s viewer at TURN, since its pod has no reachable UDP', async () => {
    const self = await viewer().grants.grantViewer(ORG, CID, { userId: 'user_owner', mode: 'view' })
    const managed = await viewer({ kind: 'managed' }).grants.grantViewer(ORG, CID, {
      userId: 'user_owner',
      mode: 'view'
    })
    expect(self).toMatchObject({ granted: true, directMedia: true })
    expect(managed).toMatchObject({ granted: true, directMedia: false })
  })

  it('names the relays’ STUN servers to both peers while only the owner may watch', async () => {
    const result = await viewer().grants.grantViewer(ORG, CID, { userId: 'user_owner', mode: 'control' })
    if (!result.granted) throw new Error('refused')
    expect(result.stunUrls).toEqual(stun.slice(0, 2))
    expect(readComputerChannelToken(result.token)?.stun).toEqual(stun.slice(0, 2))
  })

  it('keeps the desktop’s public IP from other members unless the policy turns peer to peer on', async () => {
    const shared = await viewer({}, { policy: { allowedMembers: ['user_owner', 'user_other'] } }).grants.grantViewer(
      ORG,
      CID,
      { userId: 'user_other', mode: 'view' }
    )
    if (!shared.granted) throw new Error('refused')
    expect(shared.stunUrls).toEqual([])
    expect(readComputerChannelToken(shared.token)?.stun).toBeUndefined()
    const optedIn = await viewer(
      {},
      { policy: { allowedMembers: ['user_owner', 'user_other'], viewerPeerToPeer: true } }
    ).grants.grantViewer(ORG, CID, { userId: 'user_other', mode: 'view' })
    if (!optedIn.granted) throw new Error('refused')
    expect(optedIn.stunUrls).toHaveLength(2)
    const optedOut = await viewer({}, { policy: { viewerPeerToPeer: false } }).grants.grantViewer(ORG, CID, {
      userId: 'user_owner',
      mode: 'control'
    })
    if (!optedOut.granted) throw new Error('refused')
    expect(optedOut.stunUrls).toEqual([])
  })

  it('mints no STUN claim for a desktop that does not advertise viewer STUN, which would refuse the token', async () => {
    const old = await viewer({ capabilities: { viewer: true } } as Partial<ComputerRecord>).grants.grantViewer(
      ORG,
      CID,
      {
        userId: 'user_owner',
        mode: 'control'
      }
    )
    if (!old.granted) throw new Error('refused')
    expect(old.stunUrls).toEqual([])
    expect(readComputerChannelToken(old.token)?.stun).toBeUndefined()
  })

  it('keeps a managed Computer off peer to peer by default, since its editors may watch too', async () => {
    const managed = await viewer({ kind: 'managed' }).grants.grantViewer(ORG, CID, {
      userId: 'user_owner',
      mode: 'control'
    })
    if (!managed.granted) throw new Error('refused')
    expect(managed.stunUrls).toEqual([])
    const optedIn = await viewer({ kind: 'managed' }, { policy: { viewerPeerToPeer: true } }).grants.grantViewer(
      ORG,
      CID,
      {
        userId: 'user_owner',
        mode: 'control'
      }
    )
    if (!optedIn.granted) throw new Error('refused')
    expect(optedIn.stunUrls).toHaveLength(2)
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
