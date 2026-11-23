import { describe, expect, it } from 'vitest'
import {
  MATTERMOST_ACTION_PATH,
  MATTERMOST_CARD_NOTE_MAX,
  deriveMattermostOrgActionSecret,
  signMattermostActionToken,
  verifyMattermostActionToken,
  verifyMattermostActionTokenWithMaster,
  type MattermostActionClaims
} from './mattermost-action-token.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '33333333-3333-4333-8333-333333333333'
const CARD_ID = '44444444-4444-4444-8444-444444444444'
const SECRET = 'test-mattermost-action-secret-0123456789abcdef'

describe('mattermost-action-token', () => {
  it('defines callback path and note limit constants', () => {
    expect(MATTERMOST_ACTION_PATH).toBe('/mattermost/actions')
    expect(MATTERMOST_CARD_NOTE_MAX).toBe(400)
  })

  it.each<{ name: string; claims: MattermostActionClaims }>([
    {
      name: 'approval',
      claims: {
        v: 1,
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        channelId: 'ch123456789012345678901234',
        kind: 'approval',
        requestId: 'req-1',
        option: 0,
        exp: 2_000_000
      }
    },
    {
      name: 'elicit',
      claims: {
        v: 1,
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        channelId: 'ch123456789012345678901234',
        kind: 'elicit',
        requestId: 'req-2',
        token: null,
        exp: 2_000_000
      }
    },
    {
      name: 'capability',
      claims: {
        v: 1,
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        channelId: 'ch123456789012345678901234',
        kind: 'capability',
        requestId: 'req-3',
        cardId: CARD_ID,
        generation: 2,
        exp: 2_000_000
      }
    },
    {
      name: 'draft-approve',
      claims: {
        v: 1,
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        channelId: 'ch123456789012345678901234',
        kind: 'draft',
        requestId: 'draft-4',
        token: 'approve',
        exp: 2_000_000
      }
    },
    {
      name: 'draft-discard',
      claims: {
        v: 1,
        daemonId: DAEMON_ID,
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        channelId: 'ch123456789012345678901234',
        kind: 'draft',
        requestId: 'draft-4',
        token: 'discard',
        exp: 2_000_000
      }
    }
  ])('round-trips $name claims', ({ claims }) => {
    const signed = signMattermostActionToken(claims, SECRET)
    expect(verifyMattermostActionToken(signed, SECRET, 1_999_999)).toEqual(claims)
  })

  it('rejects tampered payloads, wrong secrets, expired tokens, and malformed strings', () => {
    const base: MattermostActionClaims = {
      v: 1,
      daemonId: DAEMON_ID,
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      channelId: 'ch123456789012345678901234',
      kind: 'approval',
      requestId: 'req-1',
      option: 1,
      exp: 10_000
    }
    const token = signMattermostActionToken(base, SECRET)
    const [payload, sig] = token.split('.')

    expect(verifyMattermostActionToken(token, 'wrong-secret', 5_000)).toBeNull()
    expect(verifyMattermostActionToken(token, '', 5_000)).toBeNull()
    expect(verifyMattermostActionToken(token, SECRET, 10_000)).toBeNull()
    expect(verifyMattermostActionToken(token, SECRET, 10_001)).toBeNull()

    const alteredPayload = Buffer.from(JSON.stringify({ ...base, option: 2 })).toString('base64url')
    expect(verifyMattermostActionToken(`${alteredPayload}.${sig}`, SECRET, 5_000)).toBeNull()
    expect(verifyMattermostActionToken(`${payload}.tampered`, SECRET, 5_000)).toBeNull()
    expect(verifyMattermostActionToken('not-a-token', SECRET, 5_000)).toBeNull()
    expect(verifyMattermostActionToken('a.b.c', SECRET, 5_000)).toBeNull()
  })

  it('isolates org-scoped mm1 tokens so one tenant org secret cannot forge or verify another org', () => {
    const orgASecret = deriveMattermostOrgActionSecret(SECRET, 'org-a')
    const orgBSecret = deriveMattermostOrgActionSecret(SECRET, 'org-b')
    expect(orgASecret).not.toBe(SECRET)
    expect(orgASecret).not.toBe(orgBSecret)

    const claimsA: MattermostActionClaims = {
      v: 1,
      orgId: 'org-a',
      daemonId: DAEMON_ID,
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      channelId: 'ch123456789012345678901234',
      kind: 'approval',
      requestId: 'req-org',
      option: 0,
      exp: 10_000
    }
    const tokenA = signMattermostActionToken(claimsA, orgASecret)
    expect(tokenA.startsWith('mm1.')).toBe(true)
    expect(verifyMattermostActionToken(tokenA, orgASecret, 5_000)).toEqual(claimsA)
    expect(verifyMattermostActionTokenWithMaster(tokenA, SECRET, 5_000)).toEqual(claimsA)
    // Master verifier rejects legacy unscoped 2-part tokens even if signed with master secret.
    const unscoped = signMattermostActionToken({ ...claimsA, orgId: undefined }, SECRET)
    expect(verifyMattermostActionTokenWithMaster(unscoped, SECRET, 5_000)).toBeNull()
    // Org B cannot verify or forge an Org A token, and swapping orgId prefix fails signature/binding check.
    expect(verifyMattermostActionToken(tokenA, orgBSecret, 5_000)).toBeNull()
    const parts = tokenA.split('.')
    const orgBB64 = Buffer.from('org-b', 'utf8').toString('base64url')
    expect(verifyMattermostActionTokenWithMaster(`mm1.${orgBB64}.${parts[2]}.${parts[3]}`, SECRET, 5_000)).toBeNull()
    // Rejects dot-segment traversal IDs.
    expect(() => signMattermostActionToken({ ...claimsA, channelId: '..' }, orgASecret)).toThrow()
    expect(() => signMattermostActionToken({ ...claimsA, orgId: '../other' }, orgASecret)).toThrow()
  })
})
