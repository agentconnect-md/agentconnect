/**
 * PgMcpProviderOauthRepo / SecretStore / StateStore — the two properties the whole OAuth
 * design rests on (docs/designs/mcp-provider-oauth.md):
 *
 *  - a token pair is only ever visible together with the `tokenVersion` it was minted
 *    against, so no reader sees a `connected` row holding a stale or missing pair; and
 *  - any write that changes user intent advances that version, so a refresh already in
 *    flight loses its CAS instead of resurrecting a grant that was just replaced or revoked.
 *
 * Both are enforced in transactions inside the repo, which is why they are tested here
 * against a real Postgres rather than against a fake.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { randomUUID } from 'node:crypto'
import {
  PgMcpProviderOauthRepo,
  PgMcpProviderOauthSecretStore,
  PgMcpProviderOauthStateStore,
  PgMcpProviderRepo
} from '../../src/persistence/index.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { PrepareMcpProviderOauthInput } from '../../src/persistence/ports.js'

const ORG = OrgId(DEFAULT_ORG_ID)
const OTHER_ORG = OrgId('org-not-ours')
const ISSUER = 'https://auth.example.test'

const repo = (): PgMcpProviderOauthRepo => new PgMcpProviderOauthRepo(prisma)
const secrets = (): PgMcpProviderOauthSecretStore =>
  new PgMcpProviderOauthSecretStore(prisma, new PlaintextSecretCipher())
const states = (): PgMcpProviderOauthStateStore => new PgMcpProviderOauthStateStore(prisma)

const PREPARED: PrepareMcpProviderOauthInput = {
  resource: 'https://mcp.example.test/mcp',
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/authorize`,
  tokenEndpoint: `${ISSUER}/token`,
  registrationEndpoint: `${ISSUER}/register`,
  scopes: ['files:read'],
  clientId: 'client-1',
  clientSource: 'dynamic',
  sealedClientSecret: 'client-secret-1'
}

async function makeProvider(name = `oauth-${randomUUID().slice(0, 8)}`): Promise<string> {
  const row = await new PgMcpProviderRepo(prisma).create({
    orgId: ORG,
    name,
    url: 'https://mcp.example.test/mcp',
    auth: 'oauth2'
  })
  return row.id
}

/** Prepare + connect, the ordinary path a completed funnel takes. */
async function connected(): Promise<{ providerId: string; version: bigint }> {
  const providerId = await makeProvider()
  await repo().prepare(ORG, providerId, PREPARED)
  const row = await repo().connect(ORG, providerId, {
    accessExpiresAt: new Date(Date.now() + 3600_000),
    connectedByUserId: null,
    sealedPair: { accessToken: 'access-1', refreshToken: 'refresh-1' }
  })
  return { providerId, version: row.tokenVersion }
}

describe('PgMcpProviderOauthRepo', () => {
  it('records the published resource verbatim and keeps the row pending until a grant lands', async () => {
    const providerId = await makeProvider()
    const row = await repo().prepare(ORG, providerId, { ...PREPARED, resource: 'https://mcp.example.test/mcp/' })
    expect(row.status).toBe('pending')
    expect(row.resource).toBe('https://mcp.example.test/mcp/')
    expect(row.clientSource).toBe('dynamic')
    expect(await secrets().get(ORG, providerId)).toEqual({
      clientSecret: 'client-secret-1',
      accessToken: null,
      refreshToken: null
    })
  })

  it('publishes the pair and the connected status together', async () => {
    const { providerId } = await connected()
    const row = await repo().get(ORG, providerId)
    expect(row?.status).toBe('connected')
    expect(await secrets().get(ORG, providerId)).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' })
  })

  it('commits a refresh under the version CAS and refuses a stale one', async () => {
    const { providerId, version } = await connected()
    const later = new Date(Date.now() + 7200_000)
    expect(await repo().commitRefresh(providerId, version, later, { accessToken: 'a2', refreshToken: 'r2' })).toBe(true)
    // The same expected version again is exactly what a second flight holding a spent
    // refresh token would present. It must not land.
    expect(await repo().commitRefresh(providerId, version, later, { accessToken: 'a3', refreshToken: 'r3' })).toBe(
      false
    )
    expect(await secrets().get(ORG, providerId)).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' })
  })

  it('lets a re-run of the funnel void a pair minted against the old client identity', async () => {
    const { providerId, version } = await connected()
    await repo().prepare(ORG, providerId, { ...PREPARED, clientId: 'client-2' })
    const reprepared = await repo().get(ORG, providerId)
    expect(reprepared?.status).toBe('pending')
    expect(reprepared?.clientId).toBe('client-2')
    expect(await secrets().get(ORG, providerId)).toEqual({
      clientSecret: 'client-secret-1',
      accessToken: null,
      refreshToken: null
    })
    // A refresh that was already in flight against the previous identity loses.
    expect(await repo().commitRefresh(providerId, version, new Date(), { accessToken: 'x', refreshToken: 'y' })).toBe(
      false
    )
  })

  it('disconnects atomically and defeats an in-flight refresh CAS', async () => {
    const { providerId, version } = await connected()
    expect(await repo().disconnect(ORG, providerId)).toBe(true)
    const row = await repo().get(ORG, providerId)
    expect(row?.status).toBe('pending')
    expect(row?.accessExpiresAt).toBeNull()
    expect(await secrets().get(ORG, providerId)).toMatchObject({ accessToken: null, refreshToken: null })
    expect(await repo().commitRefresh(providerId, version, new Date(), { accessToken: 'x', refreshToken: 'y' })).toBe(
      false
    )
  })

  it('fences every org-addressed method through the parent provider', async () => {
    const { providerId } = await connected()
    expect(await repo().get(OTHER_ORG, providerId)).toBeNull()
    expect(await secrets().get(OTHER_ORG, providerId)).toBeNull()
    expect(await repo().disconnect(OTHER_ORG, providerId)).toBe(false)
    await expect(repo().prepare(OTHER_ORG, providerId, PREPARED)).rejects.toThrow()
  })

  it('elects one lease holder, and hands an expired lease to the next claimant', async () => {
    const { providerId } = await connected()
    const now = new Date()
    const until = new Date(now.getTime() + 30_000)
    expect(await repo().claimRefreshLease(providerId, 'cp-a', until, now)).toBe(true)
    expect(await repo().claimRefreshLease(providerId, 'cp-b', until, now)).toBe(false)
    // Re-entrant for the holder, and claimable again once the lease has lapsed (crash recovery).
    expect(await repo().claimRefreshLease(providerId, 'cp-a', until, now)).toBe(true)
    expect(await repo().claimRefreshLease(providerId, 'cp-b', until, new Date(until.getTime() + 1_000))).toBe(true)
    await repo().releaseRefreshLease(providerId, 'cp-b')
    expect(await repo().claimRefreshLease(providerId, 'cp-c', until, now)).toBe(true)
  })

  it('marks reauth_required only at the version the outcome was produced at', async () => {
    const { providerId, version } = await connected()
    expect(await repo().markReauthRequired(providerId, version - 1n)).toBe(false)
    expect(await repo().markReauthRequired(providerId, version)).toBe(true)
    expect((await repo().get(ORG, providerId))?.status).toBe('reauth_required')
  })

  it('sweeps connected rows due for renewal, with the org and name the re-push needs', async () => {
    const { providerId } = await connected()
    const soon = await makeProvider()
    await repo().prepare(ORG, soon, PREPARED)
    await repo().connect(ORG, soon, {
      accessExpiresAt: new Date(Date.now() + 30_000),
      connectedByUserId: null,
      sealedPair: { accessToken: 'a', refreshToken: 'r' }
    })
    const due = await repo().dueForRefresh(new Date(Date.now() + 60_000), 50)
    expect(due.map((d) => d.mcpProviderId)).toContain(soon)
    expect(due.map((d) => d.mcpProviderId)).not.toContain(providerId)
    expect(due.find((d) => d.mcpProviderId === soon)?.orgId).toBe(DEFAULT_ORG_ID)
    expect(due.find((d) => d.mcpProviderId === soon)?.providerName).toEqual(expect.stringContaining('oauth-'))
  })

  it('never sweeps a row that is pending or needs reauthorization', async () => {
    const providerId = await makeProvider()
    await repo().prepare(ORG, providerId, PREPARED)
    const far = new Date(Date.now() + 86_400_000)
    expect((await repo().dueForRefresh(far, 50)).map((d) => d.mcpProviderId)).not.toContain(providerId)
  })
})

describe('PgMcpProviderOauthStateStore', () => {
  const row = (nonce: string, providerId: string, expiresAt: Date) => ({
    nonce,
    mcpProviderId: providerId,
    orgId: DEFAULT_ORG_ID,
    userId: 'user-1',
    returnPath: '/tools',
    verifier: 'sealed-verifier',
    expectedIssuer: ISSUER,
    expiresAt
  })

  it('binds the browser exactly once, and reads the same way for a replay as for a forgery', async () => {
    const providerId = await makeProvider()
    const nonce = randomUUID()
    await states().put(row(nonce, providerId, new Date(Date.now() + 900_000)))
    const bound = await states().bindBrowser(nonce, 'hash-1', new Date())
    expect(bound?.expectedIssuer).toBe(ISSUER)
    expect(await states().bindBrowser(nonce, 'hash-2', new Date())).toBeNull()
    expect(await states().bindBrowser(randomUUID(), 'hash-2', new Date())).toBeNull()
  })

  it('refuses to bind an already-expired row', async () => {
    const providerId = await makeProvider()
    const nonce = randomUUID()
    await states().put(row(nonce, providerId, new Date(Date.now() - 1_000)))
    expect(await states().bindBrowser(nonce, 'hash-1', new Date())).toBeNull()
  })

  it('consumes exactly once, and treats an expired row as consumed', async () => {
    const providerId = await makeProvider()
    const fresh = randomUUID()
    await states().put(row(fresh, providerId, new Date(Date.now() + 900_000)))
    expect((await states().consume(fresh, new Date()))?.returnPath).toBe('/tools')
    expect(await states().consume(fresh, new Date())).toBeNull()

    const stale = randomUUID()
    await states().put(row(stale, providerId, new Date(Date.now() - 1_000)))
    expect(await states().consume(stale, new Date())).toBeNull()
  })

  it('reaps expired rows so an abandoned funnel does not keep a sealed verifier around', async () => {
    const providerId = await makeProvider()
    const stale = randomUUID()
    const live = randomUUID()
    await states().put(row(stale, providerId, new Date(Date.now() - 1_000)))
    await states().put(row(live, providerId, new Date(Date.now() + 900_000)))
    expect(await states().reapExpired(new Date())).toBeGreaterThanOrEqual(1)
    expect(await states().consume(stale, new Date())).toBeNull()
    expect(await states().consume(live, new Date())).not.toBeNull()
  })
})
