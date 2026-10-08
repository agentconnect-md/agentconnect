// OAuth garbage collection (agent-assistant.md §7.4) over real Postgres: only dead rows past the cutoff disappear.
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { seedAgent } from '../fixtures/seed.js'
import { PgOAuthRepo } from '../../src/persistence/repositories/oauth.repo.js'
import { PgApiKeyRepo } from '../../src/persistence/repositories/api-key.repo.js'
import { OAuthReaper } from '../../src/orchestrator/oauthReaper.js'
import { FakeClock } from '../fakes/fake-clock.js'

const CUTOFF = new Date('2026-07-01T00:00:00.000Z')
const HOUR = 3_600_000
const before = (ms: number) => new Date(CUTOFF.getTime() - ms)
const after = (ms: number) => new Date(CUTOFF.getTime() + ms)

const AGENT = 'a1111111-1111-4111-8111-111111111111'
const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'

async function code(codeHash: string, expiresAt: Date, consumedAt: Date | null = null): Promise<void> {
  await prisma.oAuthCode.create({
    data: {
      codeHash,
      clientId: 'mcp-client-live',
      redirectUri: 'https://client.example.test/callback',
      userId: DEFAULT_OWNER_ID,
      orgId: DEFAULT_ORG_ID,
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      expiresAt,
      consumedAt
    }
  })
}

async function client(clientId: string, expiresAt: Date): Promise<void> {
  await prisma.oAuthClient.create({
    data: { clientId, redirectUris: ['https://client.example.test/callback'], expiresAt }
  })
}

async function key(
  id: string,
  opts: { principalType?: 'oauth' | 'user' | 'relay'; expiresAt?: Date | null; revokedAt?: Date | null } = {}
): Promise<void> {
  const principalType = opts.principalType ?? 'oauth'
  await prisma.apiKey.create({
    data: {
      id,
      principalType,
      orgId: principalType === 'relay' ? null : DEFAULT_ORG_ID,
      userId: principalType === 'relay' ? null : DEFAULT_OWNER_ID,
      hash: `hash-${id}`,
      displayTail: '…test',
      scopes: principalType === 'oauth' ? ['mcp:read', 'mcp:write'] : [],
      oauthGrantId: principalType === 'oauth' ? 'grant-live' : null,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null
    }
  })
}

const codeHashes = async () => (await prisma.oAuthCode.findMany()).map((c) => c.codeHash).sort()
const clientIds = async () => (await prisma.oAuthClient.findMany()).map((c) => c.clientId).sort()
const grantIds = async () => (await prisma.oAuthGrant.findMany()).map((g) => g.id).sort()
const keyIds = async () => (await prisma.apiKey.findMany()).map((k) => k.id).sort()

describe('OAuth garbage collection (real Postgres)', () => {
  it('deletes codes consumed or expired before the cutoff and keeps the rest', async () => {
    await code('code-expired', before(HOUR))
    await code('code-consumed', after(HOUR), before(HOUR))
    await code('code-expired-within-grace', after(HOUR / 2))
    await code('code-consumed-within-grace', after(2 * HOUR), after(HOUR))
    await code('code-live', after(24 * HOUR))

    const res = await new PgOAuthRepo(prisma).reapExpired(CUTOFF)

    expect(res.codes).toBe(2)
    expect(await codeHashes()).toEqual(['code-consumed-within-grace', 'code-expired-within-grace', 'code-live'])
  })

  it('deletes clients expired before the cutoff and never touches a grant', async () => {
    await client('mcp-client-expired', before(HOUR))
    await client('mcp-client-expired-within-grace', after(HOUR))
    await client('mcp-client-live', after(90 * 24 * HOUR))
    // Grants name clients by text only, so a grant of a reaped client survives, whether live or revoked.
    await prisma.oAuthGrant.create({
      data: {
        id: 'grant-live',
        userId: DEFAULT_OWNER_ID,
        orgId: DEFAULT_ORG_ID,
        clientId: 'mcp-client-expired',
        rtHash: 'rt-live',
        rtExpiresAt: after(30 * 24 * HOUR)
      }
    })
    await prisma.oAuthGrant.create({
      data: {
        id: 'grant-revoked',
        userId: DEFAULT_OWNER_ID,
        orgId: DEFAULT_ORG_ID,
        clientId: 'mcp-client-expired',
        rtHash: 'rt-revoked',
        revokedAt: before(24 * HOUR)
      }
    })

    const res = await new PgOAuthRepo(prisma).reapExpired(CUTOFF)

    expect(res.clients).toBe(1)
    expect(await clientIds()).toEqual(['mcp-client-expired-within-grace', 'mcp-client-live'])
    expect(await grantIds()).toEqual(['grant-live', 'grant-revoked'])
  })

  it('deletes dead oauth access tokens only, keeping live ones, other principals and conversation-named keys', async () => {
    await seedAgent(prisma, AGENT)
    await key('oauth-expired', { expiresAt: before(HOUR) })
    await key('oauth-revoked', { expiresAt: after(HOUR), revokedAt: before(HOUR) })
    await key('oauth-revoked-no-expiry', { revokedAt: before(HOUR) })
    await key('oauth-expired-within-grace', { expiresAt: after(HOUR) })
    await key('oauth-revoked-within-grace', { expiresAt: after(2 * HOUR), revokedAt: after(HOUR) })
    await key('oauth-live', { expiresAt: after(24 * HOUR) })
    await key('oauth-expired-named', { expiresAt: before(HOUR) })
    await key('user-expired', { principalType: 'user', expiresAt: before(HOUR) })
    await key('relay-revoked', { principalType: 'relay', revokedAt: before(HOUR) })
    await prisma.webchatConversation.create({
      data: {
        id: CONVERSATION,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        userId: DEFAULT_OWNER_ID,
        apiKeyId: 'oauth-expired-named'
      }
    })

    expect(await new PgApiKeyRepo(prisma).reapOAuthAccessTokens(CUTOFF)).toBe(3)

    expect(await keyIds()).toEqual([
      'oauth-expired-named',
      'oauth-expired-within-grace',
      'oauth-live',
      'oauth-revoked-within-grace',
      'relay-revoked',
      'user-expired'
    ])
    const conversation = await prisma.webchatConversation.findUnique({ where: { id: CONVERSATION } })
    expect(conversation?.apiKeyId).toBe('oauth-expired-named')
  })

  it('drains a backlog larger than one delete batch in a single call', async () => {
    const backlog = 2_345
    await prisma.apiKey.createMany({
      data: Array.from({ length: backlog }, (_, i) => ({
        id: `oauth-backlog-${i}`,
        principalType: 'oauth' as const,
        orgId: DEFAULT_ORG_ID,
        userId: DEFAULT_OWNER_ID,
        hash: `hash-backlog-${i}`,
        displayTail: '…test',
        expiresAt: before(HOUR + i)
      }))
    })
    await key('oauth-live', { expiresAt: after(HOUR) })

    expect(await new PgApiKeyRepo(prisma).reapOAuthAccessTokens(CUTOFF)).toBe(backlog)
    expect(await keyIds()).toEqual(['oauth-live'])
  })

  it('one reaper tick sweeps all three tables with cutoff = now − grace', async () => {
    const grace = 7 * 24 * HOUR
    const clock = new FakeClock(CUTOFF.getTime() + grace)
    await code('code-expired', before(HOUR))
    await code('code-live', after(grace + HOUR))
    await client('mcp-client-expired', before(HOUR))
    await client('mcp-client-live', after(grace + HOUR))
    await key('oauth-expired', { expiresAt: before(HOUR) })
    await key('oauth-live', { expiresAt: after(grace + HOUR) })

    const reaper = new OAuthReaper(new PgOAuthRepo(prisma), new PgApiKeyRepo(prisma), clock, {
      intervalMs: 10 * 60_000,
      graceMs: grace
    })
    await reaper.tick()
    reaper.stop()

    expect(await codeHashes()).toEqual(['code-live'])
    expect(await clientIds()).toEqual(['mcp-client-live'])
    expect(await keyIds()).toEqual(['oauth-live'])
  })
})
