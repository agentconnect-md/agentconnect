import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationMattermostConfig, type IntegrationCoreEnvelope } from '@agentconnect.md/protocol'
import {
  createMattermostCpProvider,
  deriveMattermostActionSecret,
  mattermostExternalAppId,
  normalizeMattermostServerUrl,
  verifyMattermostBot
} from './provider.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import type { BotRecord, IntegrationRecord } from '../../persistence/ports.js'

const SERVER_URL = 'https://chat.example.com/team'
const BOT_TOKEN = 'mm-bot-token-placeholder'
const BOT_USER_ID = 'botuser1234567890abcdef12'
const BOT_USERNAME = 'agentbot'

const EXPECTED_APP_ID = `mm-${createHash('sha256').update(SERVER_URL).digest('hex').slice(0, 16)}`

describe('Mattermost serverUrl normalization and SSRF policy', () => {
  it('normalizes scheme/host casing, strips default ports and trailing slashes, and preserves subpaths', () => {
    expect(normalizeMattermostServerUrl('  HTTPS://Chat.Example.COM:443/Team/Sub/  ')).toEqual({
      ok: true,
      serverUrl: 'https://chat.example.com/Team/Sub'
    })
    expect(normalizeMattermostServerUrl('https://chat.example.com///')).toEqual({
      ok: true,
      serverUrl: 'https://chat.example.com'
    })
    expect(normalizeMattermostServerUrl('http://mm.internal:8065/mattermost/')).toEqual({
      ok: true,
      serverUrl: 'http://mm.internal:8065/mattermost'
    })
    expect(normalizeMattermostServerUrl('http://mm.internal:80/')).toEqual({
      ok: true,
      serverUrl: 'http://mm.internal'
    })
  })

  it('allows self-hosted private, loopback, ULA, and intranet addresses over http://', () => {
    for (const url of [
      'http://127.0.0.1:8065',
      'http://localhost:8065/mm/',
      'http://[::1]:8065',
      'http://10.0.1.25:8065',
      'http://172.16.4.10',
      'http://192.168.1.50/sub/',
      'http://100.64.1.2:8065',
      'http://[fc00::1]:8065',
      'http://[fd12:3456::1]:8065',
      'http://mattermost.corp.internal:8065'
    ]) {
      expect(normalizeMattermostServerUrl(url), url).toMatchObject({ ok: true })
    }
  })

  it('rejects link-local, metadata, unspecified, non-http(s), userinfo, query, fragment, and malformed URLs', () => {
    for (const bad of [
      '',
      '   ',
      'not a url',
      'ftp://chat.example.com',
      'ws://chat.example.com',
      'wss://chat.example.com',
      'file:///etc/passwd',
      'https://user:pass@chat.example.com',
      'https://user@chat.example.com',
      'https://@chat.example.com',
      'https://chat.example.com?foo=bar',
      'https://chat.example.com/?',
      'https://chat.example.com#frag',
      'https://chat.example.com/#',
      'https://chat.example.com/\npath',
      'http://169.254.169.254',
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.0.1:8065',
      'http://2852039166',
      'http://[::ffff:169.254.169.254]',
      'http://[fe80::1]:8065',
      'http://[febf::1]',
      'http://0.0.0.0:8065',
      'http://0:8065',
      'http://[::]:8065',
      'http://[::ffff:0.0.0.0]'
    ]) {
      expect(normalizeMattermostServerUrl(bad), bad).toMatchObject({ ok: false })
    }
  })

  it('derives a colon-free 19-char externalAppId from the normalized serverUrl', () => {
    expect(mattermostExternalAppId(SERVER_URL)).toBe(EXPECTED_APP_ID)
    expect(EXPECTED_APP_ID).toMatch(/^mm-[0-9a-f]{16}$/)
    expect(EXPECTED_APP_ID).not.toContain(':')
    expect(mattermostExternalAppId('https://chat.example.com')).not.toBe(EXPECTED_APP_ID)
  })
})

describe('Mattermost credential check', () => {
  it('verifies a Bot Account via GET /api/v4/users/me and captures normalized config', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: BOT_USER_ID, username: BOT_USERNAME, is_bot: true }))
    const result = await verifyMattermostBot(
      { serverUrl: 'HTTPS://Chat.Example.com/team/', botToken: BOT_TOKEN },
      { fetch: fetchImpl }
    )
    expect(result).toEqual({
      ok: true,
      identity: {
        name: `Mattermost · ${BOT_USERNAME}`,
        botName: BOT_USERNAME,
        externalAppId: EXPECTED_APP_ID,
        botUserId: BOT_USER_ID,
        workspaceName: 'chat.example.com',
        platformConfig: {
          serverUrl: SERVER_URL,
          botUserId: BOT_USER_ID,
          botUsername: BOT_USERNAME
        }
      }
    })
    expect(fetchImpl).toHaveBeenCalledWith(`${SERVER_URL}/api/v4/users/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: expect.any(AbortSignal)
    })
  })

  it('accepts Personal Access Tokens where is_bot is false or omitted', async () => {
    for (const payload of [
      { id: BOT_USER_ID, username: BOT_USERNAME, is_bot: false },
      { id: BOT_USER_ID, username: BOT_USERNAME }
    ]) {
      const fetchImpl = vi.fn(async () => Response.json(payload))
      const result = await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: fetchImpl })
      expect(result.ok).toBe(true)
    }
  })

  it('rejects bad or blocked serverUrl before issuing any HTTP request', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: BOT_USER_ID, username: BOT_USERNAME }))
    for (const serverUrl of ['http://169.254.169.254', 'http://[fe80::1]', 'http://0.0.0.0:8065', 'ftp://mm.local']) {
      const res = await verifyMattermostBot({ serverUrl, botToken: BOT_TOKEN }, { fetch: fetchImpl })
      expect(res).toMatchObject({ ok: false, status: 400, code: 'MATTERMOST_SERVER_URL_INVALID' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps 401/403 to invalid credentials, 404/malformed 200 to invalid server URL, and 5xx/redirect/network errors to unavailable', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => Response.json({ message: 'Invalid session' }, { status }))
      expect(
        await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: fetchImpl }),
        String(status)
      ).toMatchObject({ ok: false, status: 400, code: 'MATTERMOST_CREDENTIALS_INVALID' })
    }

    const notFound = vi.fn(async () => Response.json({ message: 'Not Found' }, { status: 404 }))
    expect(
      await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: notFound })
    ).toMatchObject({ ok: false, status: 400, code: 'MATTERMOST_SERVER_URL_INVALID' })

    const nonMattermost = vi.fn(async () => new Response('<html>Login</html>', { status: 200 }))
    expect(
      await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: nonMattermost })
    ).toMatchObject({ ok: false, status: 400, code: 'MATTERMOST_SERVER_URL_INVALID' })

    for (const fetchImpl of [
      vi.fn(async () => Response.json({}, { status: 500 })),
      vi.fn(async () => Response.json({}, { status: 503 })),
      vi.fn(async () => Response.json({}, { status: 429 })),
      vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254' } })),
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      vi.fn(async () => {
        throw new DOMException('Timed out', 'TimeoutError')
      })
    ]) {
      expect(
        await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: fetchImpl })
      ).toMatchObject({ ok: false, status: 503, code: 'MATTERMOST_CHECK_UNAVAILABLE' })
    }
  })

  it('blocks private/loopback servers by default in verifyMattermostBot unless allowPrivateNetwork or allowlist permits them', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/v4/users/me') {
        res.end(JSON.stringify({ id: BOT_USER_ID, username: BOT_USERNAME, is_bot: true }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      const localUrl = `http://127.0.0.1:${port}`
      expect(await verifyMattermostBot({ serverUrl: localUrl, botToken: BOT_TOKEN })).toMatchObject({
        ok: false,
        status: 400,
        code: 'MATTERMOST_SERVER_URL_INVALID'
      })
      expect(
        await verifyMattermostBot({ serverUrl: localUrl, botToken: BOT_TOKEN }, { allowlist: new Set(['127.0.0.1']) })
      ).toMatchObject({ ok: true })
      expect(
        await verifyMattermostBot({ serverUrl: localUrl, botToken: BOT_TOKEN }, { allowPrivateNetwork: true })
      ).toMatchObject({ ok: true })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('never leaks the botToken in refusals', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}, { status: 401 }))
    const res = await verifyMattermostBot({ serverUrl: SERVER_URL, botToken: BOT_TOKEN }, { fetch: fetchImpl })
    expect(JSON.stringify(res)).not.toContain(BOT_TOKEN)
  })
})

describe('Mattermost provider validation and installation', () => {
  it('refuses an already-installed (serverUrl, botUserId) pair with 409', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: BOT_USER_ID, username: BOT_USERNAME, is_bot: true }))
    const isInstalled = vi.fn(
      async (appId: string, userId: string) => appId === EXPECTED_APP_ID && userId === BOT_USER_ID
    )
    const provider = createMattermostCpProvider({ fetch: fetchImpl, isInstalled })

    const res = await provider.validateConfig({ serverUrl: `${SERVER_URL}/`, botToken: BOT_TOKEN }, 'socket')
    expect(res).toMatchObject({
      ok: false,
      status: 409,
      code: 'MATTERMOST_BOT_ALREADY_INSTALLED'
    })
    expect(isInstalled).toHaveBeenCalledWith(EXPECTED_APP_ID, BOT_USER_ID)
  })

  it('builds the bot install rows, stores no token in platformConfig, and fences D6 identity', () => {
    const provider = createMattermostCpProvider()
    const install = provider.buildNewBotInstall({
      credentials: { serverUrl: `${SERVER_URL}/`, botToken: BOT_TOKEN },
      identity: {
        name: `Mattermost · ${BOT_USERNAME}`,
        botName: BOT_USERNAME,
        externalAppId: EXPECTED_APP_ID,
        botUserId: BOT_USER_ID,
        workspaceName: 'chat.example.com',
        platformConfig: {
          serverUrl: SERVER_URL,
          botUserId: BOT_USER_ID,
          botUsername: BOT_USERNAME
        }
      },
      transport: 'socket',
      shareable: true // Mattermost is socket-only, and core/provider do not advertise shareable.
    })

    expect(install.secrets).toEqual({ botToken: BOT_TOKEN, appToken: null, signingSecret: null })
    expect(install.bot).toEqual({
      externalAppId: EXPECTED_APP_ID,
      botUserId: BOT_USER_ID,
      workspaceName: 'chat.example.com',
      platformConfig: {
        serverUrl: SERVER_URL,
        botUserId: BOT_USER_ID,
        botUsername: BOT_USERNAME
      }
    })
    expect(JSON.stringify(install.bot)).not.toContain(BOT_TOKEN)
    expect(install.externalIdentity).toEqual({
      externalAppId: EXPECTED_APP_ID,
      externalTenantId: BOT_USER_ID,
      conflictMessage: 'This Mattermost bot is already installed. Reuse the existing bot.'
    })
  })

  it('has no relay path and projects D6 identity + platformConfig for BotRepo.create', () => {
    const provider = createMattermostCpProvider()
    expect(provider.projectBotAssign).toBeUndefined()
    expect(provider.secretShape.httpAssignRequires).toEqual([])
    expect(provider.installRoutes('public-callback')).toEqual([])

    expect(
      provider.projectBotIdentity?.({
        externalAppId: EXPECTED_APP_ID,
        botUserId: BOT_USER_ID,
        platformConfig: { serverUrl: SERVER_URL, botUserId: BOT_USER_ID, botUsername: BOT_USERNAME }
      } as never)
    ).toEqual({
      externalAppId: EXPECTED_APP_ID,
      externalTenantId: BOT_USER_ID,
      platformConfig: { serverUrl: SERVER_URL, botUserId: BOT_USER_ID, botUsername: BOT_USERNAME }
    })

    expect(provider.projectBotIdentity?.({} as never)).toEqual({})
  })

  it('projects IntegrationMattermostConfig for the daemon and fails closed when serverUrl or token is missing', async () => {
    const provider = createMattermostCpProvider()
    const projected = await provider.projectIntegrationConfig(
      {} as IntegrationRecord,
      {
        botUserId: BOT_USER_ID,
        platformConfig: { serverUrl: SERVER_URL, botUserId: BOT_USER_ID, botUsername: BOT_USERNAME }
      } as unknown as BotRecord,
      {} as IntegrationCoreEnvelope,
      { botToken: BOT_TOKEN, appToken: null, signingSecret: null }
    )
    expect(IntegrationMattermostConfig.parse(projected)).toEqual({
      serverUrl: SERVER_URL,
      botToken: BOT_TOKEN,
      botUserId: BOT_USER_ID,
      botUsername: BOT_USERNAME
    })

    expect(
      await provider.projectIntegrationConfig(
        {} as IntegrationRecord,
        { platformConfig: null } as unknown as BotRecord,
        {} as IntegrationCoreEnvelope,
        { botToken: BOT_TOKEN, appToken: null, signingSecret: null }
      )
    ).toBeUndefined()

    expect(
      await provider.projectIntegrationConfig(
        {} as IntegrationRecord,
        { platformConfig: { serverUrl: SERVER_URL } } as unknown as BotRecord,
        {} as IntegrationCoreEnvelope,
        { botToken: '', appToken: null, signingSecret: null }
      )
    ).toBeUndefined()
  })

  it('exposes the credential block through the create integration body schema', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createMattermostCpProvider()]))
    const agentId = '00000000-0000-4000-8000-000000000001'
    expect(
      schema.safeParse({
        platform: 'mattermost',
        agentId,
        mattermost: { serverUrl: SERVER_URL, botToken: BOT_TOKEN }
      }).success
    ).toBe(true)
    expect(
      schema.safeParse({
        platform: 'mattermost',
        agentId,
        mattermost: { serverUrl: '  ', botToken: BOT_TOKEN }
      }).success
    ).toBe(false)
    expect(
      schema.safeParse({
        platform: 'mattermost',
        agentId,
        mattermost: { serverUrl: SERVER_URL, botToken: '  ' }
      }).success
    ).toBe(false)
  })

  it('declares envSchema, legacySessionAudience, sessionAudienceRealm, and chatMemberTenant', () => {
    const provider = createMattermostCpProvider()
    expect(Object.keys(provider.envSchema ?? {}).sort()).toEqual([
      'MATTERMOST_ACTION_SECRET',
      'MATTERMOST_ALLOW_PRIVATE_NETWORK',
      'MATTERMOST_OAUTH_SERVER_URL'
    ])

    expect(provider.legacySessionAudience?.('mmchan1234567890abcdefghij')).toBe(true)
    expect(provider.legacySessionAudience?.('not-a-channel')).toBe(false)
    expect(provider.legacySessionAudience?.('UPPER123456789012345678901')).toBe(false)

    const active = {
      revokedAt: null,
      externalAppId: EXPECTED_APP_ID,
      platformConfig: { serverUrl: SERVER_URL, botUserId: BOT_USER_ID, botUsername: BOT_USERNAME }
    } as unknown as BotRecord
    expect(provider.sessionAudienceRealm?.(active)).toBe(EXPECTED_APP_ID)
    expect(provider.chatMemberTenant?.(active)).toBe(EXPECTED_APP_ID)

    const revoked = { ...active, revokedAt: new Date() } as unknown as BotRecord
    expect(provider.sessionAudienceRealm?.(revoked)).toBe(EXPECTED_APP_ID)
    expect(provider.chatMemberTenant?.(revoked)).toBeNull()

    const fallbackOnly = {
      revokedAt: null,
      externalAppId: EXPECTED_APP_ID,
      platformConfig: null
    } as unknown as BotRecord
    expect(provider.sessionAudienceRealm?.(fallbackOnly)).toBe(EXPECTED_APP_ID)
    expect(provider.chatMemberTenant?.(fallbackOnly)).toBe(EXPECTED_APP_ID)
  })

  it('derives a deterministic HMAC action secret and verifies socketLifecycleRevocation', () => {
    const secretA = deriveMattermostActionSecret('pepper-a')
    const secretB = deriveMattermostActionSecret('pepper-b')
    expect(secretA.length).toBeGreaterThanOrEqual(32)
    expect(secretA).toBe(deriveMattermostActionSecret('pepper-a'))
    expect(secretA).not.toBe(secretB)

    const provider = createMattermostCpProvider()
    const bot = {
      externalAppId: EXPECTED_APP_ID,
      botUserId: BOT_USER_ID,
      platformConfig: { serverUrl: SERVER_URL, botUserId: BOT_USER_ID, botUsername: BOT_USERNAME }
    } as unknown as BotRecord

    expect(provider.socketLifecycleRevocation?.(bot, { botUserId: BOT_USER_ID, workspaceId: EXPECTED_APP_ID })).toBe(
      true
    )
    expect(
      provider.socketLifecycleRevocation?.(bot, { botUserId: 'other-bot-user', workspaceId: EXPECTED_APP_ID })
    ).toBe(false)
    expect(
      provider.socketLifecycleRevocation?.(bot, { botUserId: BOT_USER_ID, workspaceId: 'mm-deadbeefdeadbeef' })
    ).toBe(false)
  })
})
