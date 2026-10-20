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

function setup(over: Partial<ComputerRecord> = {}, policy: Record<string, unknown> = { allowedAgents: [AGENT] }) {
  const clock = new FakeClock(T0)
  const keys = new ComputerChannelKeys('unit-test-pepper-0123456789abcdefghij', 300)
  const record = {
    id: ComputerId(CID),
    orgId: ORG,
    status: 'online',
    lastSeenAt: new Date(T0 - 1000),
    policy: ComputerPolicySchema.parse(policy),
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

  it('carries a view grant into the token', async () => {
    const { grants } = setup({}, { allowedAgents: [AGENT], agentMode: 'view' })
    const result = await grants.grant(ORG, CID, who)
    expect(result).toMatchObject({ granted: true, mode: 'view' })
    if (result.granted) expect(readComputerChannelToken(result.token)?.mode).toBe('view')
  })

  it('refuses an ungranted agent, an offline or revoked Computer, and one with no live key', async () => {
    expect(await setup({}, { allowedAgents: [] }).grants.grant(ORG, CID, who)).toMatchObject({ code: 'denied' })
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
