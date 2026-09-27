/** The Chat app-identity lookup and its background loop (google-chat-integration.md §3), against a fake Google. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import { BotId, OrgId } from '../../domain/ids.js'
import type { BotRecord, BotRepo, BotSecretStore } from '../../persistence/ports.js'
import { GOOGLE_CHAT_API_ROOT, GOOGLE_TOKEN_ENDPOINT, checkServiceAccountKey } from './credential.js'
import { GoogleChatAppIdentityReconciler, resolveGoogleChatAppIdentity } from './app-identity.js'

const ORG = OrgId('11111111-1111-4111-8111-111111111111')
const BOT = BotId('88888888-8888-4888-8888-888888888888')
const PROJECT_ID = 'example-project'
const APP = 'users/100000000000000000009'
const SPACE = 'spaces/EXAMPLE_SPACE'
const NOW = new Date('2026-09-27T00:00:00.000Z')
const { privateKey: PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: PROJECT_ID,
  private_key_id: 'synthetic-key-id',
  private_key: PRIVATE_KEY,
  client_email: `agentconnect-chat@${PROJECT_ID}.iam.gserviceaccount.com`
})

function key() {
  const checked = checkServiceAccountKey(KEY_JSON, PROJECT_ID)
  if (checked.status !== 'ok') throw new Error(checked.message)
  return checked.key
}

type Answers = { spaces?: Response; membership?: Response; token?: Response }

/** Google's token endpoint, the one-space list, and the app's own membership read; every call recorded. */
function fakeGoogle(answers: Answers = {}) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return answers.token ?? Response.json({ access_token: 'synthetic-access-token', expires_in: 3599 })
    }
    if (url === `${GOOGLE_CHAT_API_ROOT}/spaces?pageSize=1`) {
      return answers.spaces ?? Response.json({ spaces: [{ name: SPACE, spaceType: 'SPACE' }] })
    }
    if (url === `${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/app`) {
      return answers.membership ?? Response.json({ name: `${SPACE}/members/app`, member: { name: APP, type: 'BOT' } })
    }
    throw new Error(`unexpected request to ${url}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function bot(over: Partial<BotRecord> = {}): BotRecord {
  return {
    id: BOT,
    orgId: ORG,
    platform: 'googlechat',
    name: `Google Chat · ${PROJECT_ID}`,
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: null,
    workspaceName: null,
    botUserId: null,
    revokedAt: null,
    revokedReason: null,
    revokedEvidence: null,
    revokedCode: null,
    credentialRejectedAt: null,
    credentialRejectedCode: null,
    credentialRevision: 1,
    credentialInstalledAt: null,
    grantedScopes: null,
    externalAppId: '123456789012',
    externalTenantId: '-',
    platformConfig: { projectId: PROJECT_ID },
    discordAppId: null,
    feishuAppId: null,
    feishuRegion: null,
    shareable: false,
    transport: 'http',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [],
    inUseByAgentId: null,
    createdAt: NOW,
    ...over
  }
}

describe('resolveGoogleChatAppIdentity', () => {
  it("reads the app's users/… name from its own membership in the first Space, sending nothing", async () => {
    const google = fakeGoogle()
    expect(await resolveGoogleChatAppIdentity(key(), google.fetchImpl, () => NOW)).toEqual({
      status: 'ok',
      appUserName: APP
    })
    expect(google.calls).toEqual([
      `POST ${GOOGLE_TOKEN_ENDPOINT}`,
      `GET ${GOOGLE_CHAT_API_ROOT}/spaces?pageSize=1`,
      `GET ${GOOGLE_CHAT_API_ROOT}/${SPACE}/members/app`
    ])
  })

  it('reports an app that is in no Space yet, and a refused key or an unnamed membership as failures', async () => {
    const empty = fakeGoogle({ spaces: Response.json({}) })
    expect(await resolveGoogleChatAppIdentity(key(), empty.fetchImpl, () => NOW)).toEqual({ status: 'no_space' })
    expect(empty.calls).toHaveLength(2)

    const refused = fakeGoogle({ token: Response.json({ error: 'invalid_grant' }, { status: 400 }) })
    expect(await resolveGoogleChatAppIdentity(key(), refused.fetchImpl, () => NOW)).toMatchObject({ status: 'failed' })
    expect(refused.calls).toHaveLength(1)

    const unnamed = fakeGoogle({ membership: Response.json({ member: { name: 'not-a-user-name' } }) })
    expect(await resolveGoogleChatAppIdentity(key(), unnamed.fetchImpl, () => NOW)).toMatchObject({ status: 'failed' })
  })
})

describe('GoogleChatAppIdentityReconciler', () => {
  function reconciler(rows: BotRecord[], google = fakeGoogle(), secretJson: string | null = KEY_JSON) {
    const setBotUserIdIfMissing = vi.fn(async () => true)
    const resync = vi.fn(async () => {})
    const bots = { listForPlatform: vi.fn(async () => rows), setBotUserIdIfMissing } as unknown as BotRepo
    const secrets = {
      get: async () => (secretJson === null ? null : { botToken: secretJson, appToken: null, signingSecret: null })
    } as unknown as BotSecretStore
    const clock = new FakeClock(NOW.getTime())
    const warn = vi.fn()
    const loop = new GoogleChatAppIdentityReconciler({
      bots,
      secrets,
      fetch: google.fetchImpl,
      resync,
      clock,
      intervalMs: 60_000,
      log: { info() {}, warn, error() {} }
    })
    return { loop, bots, setBotUserIdIfMissing, resync, clock, google, warn }
  }

  it('stores the learned identity as the bot user id and re-broadcasts the assignment', async () => {
    const r = reconciler([bot()])
    await r.loop.tick()
    expect(r.setBotUserIdIfMissing).toHaveBeenCalledWith(BOT, APP)
    expect(r.resync).toHaveBeenCalledWith(BOT)
    expect(r.google.calls).toHaveLength(3)
    expect(r.warn).not.toHaveBeenCalled()
  })

  it('leaves alone a bot that already has its identity or was revoked, and one whose row lacks its project', async () => {
    const r = reconciler([bot({ botUserId: APP }), bot({ revokedAt: NOW }), bot({ platformConfig: null })])
    await r.loop.tick()
    expect(r.setBotUserIdIfMissing).not.toHaveBeenCalled()
    expect(r.google.calls).toEqual([])
  })

  it('retries a bot that is in no Space yet on the next tick, without writing anything', async () => {
    const r = reconciler([bot()], fakeGoogle({ spaces: Response.json({ spaces: [] }) }))
    r.loop.start()
    await vi.waitFor(() => expect(r.google.calls).toHaveLength(2))
    expect(r.setBotUserIdIfMissing).not.toHaveBeenCalled()
    expect(r.resync).not.toHaveBeenCalled()
    r.clock.advance(60_000)
    await vi.waitFor(() => expect(r.google.calls).toHaveLength(4))
    r.loop.stop()
  })

  it('warns and moves on when the stored key is unusable, never surfacing the key', async () => {
    const r = reconciler([bot()], fakeGoogle(), JSON.stringify({ type: 'authorized_user' }))
    await r.loop.tick()
    expect(r.setBotUserIdIfMissing).not.toHaveBeenCalled()
    expect(r.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(r.warn.mock.calls)).not.toContain('PRIVATE KEY')
  })
})
