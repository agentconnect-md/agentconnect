/**
 * Equivalence suite for the REGISTRY-COMPOSED `POST /integrations` create body
 * (integration-plugin-architecture.md §9).
 *
 * The fixtures below are written from the behavior of the hand-written closed
 * union this composition replaces (four literal credential keys, a literal
 * four-id mismatch loop, and a `b.platform === 'slack' | 'feishu'` refine
 * dispatch): every body the old schema ACCEPTED must still be accepted, every
 * body it REJECTED must still be rejected, with the same user-facing messages.
 * That is the whole contract of the S3 refactor — the platform name stops being
 * core knowledge, the wire does not move.
 *
 * The second suite pins the regression a dynamic composition can silently lose:
 * `/api/v1/openapi.json` must still enumerate every registered platform's
 * credential variant (a docs-only loss is invisible to a parse-level test).
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { buildCreateIntegrationBody, credentialBlockOf } from './create-integration-body.js'
import { buildHttpServer } from '../server.js'
import type { HttpDeps } from '../deps.js'
import { buildCpPlatformRegistry } from '../../platforms/registry.js'
import type { CpPlatformProvider, CpPlatformRegistry } from '../../platforms/provider.js'
import { createTelegramCpProvider } from '../../platforms/telegram/provider.js'
import { createDiscordCpProvider } from '../../platforms/discord/provider.js'
import { createSlackCpProvider } from '../../platforms/slack/provider.js'
import { createFeishuCpProvider } from '../../platforms/feishu/provider.js'

/** The four production providers, composed with offline seams — the same set
 *  `buildContainer` registers, so the schema under test is the deployed one. */
function offlinePlatforms(): CpPlatformRegistry {
  return buildCpPlatformRegistry([
    createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
    createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
    createSlackCpProvider({}),
    createFeishuCpProvider({})
  ])
}

const Body = buildCreateIntegrationBody(offlinePlatforms())
const AGENT = '11111111-1111-4111-8111-111111111111'
const BOT = '22222222-2222-4222-8222-222222222222'

const messages = (input: unknown): string[] => {
  const parsed = Body.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}
const accepts = (input: unknown): boolean => Body.safeParse(input).success

describe('composed create-integration body: accepts what the closed union accepted', () => {
  it('registers a new bot from each platform’s credential block', () => {
    expect(accepts({ platform: 'slack', agentId: AGENT, slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } })).toBe(true)
    expect(accepts({ platform: 'telegram', agentId: AGENT, telegram: { botToken: '123:abc' } })).toBe(true)
    expect(accepts({ platform: 'discord', agentId: AGENT, discord: { botToken: 'MTA1.bot.token' } })).toBe(true)
    expect(accepts({ platform: 'feishu', agentId: AGENT, feishu: { appId: 'cli_x', appSecret: 's' } })).toBe(true)
  })

  it('reuses an existing bot on every platform (no credential block)', () => {
    for (const platform of ['slack', 'telegram', 'discord', 'feishu']) {
      expect(accepts({ platform, agentId: AGENT, botId: BOT })).toBe(true)
    }
  })

  it('keeps the optional core knobs and each block’s optional fields', () => {
    expect(
      accepts({
        name: 'acme',
        platform: 'slack',
        agentId: AGENT,
        shareable: true,
        transport: 'http',
        slack: { botToken: 'xoxb-1', signingSecret: 'sig' }
      })
    ).toBe(true)
    expect(
      accepts({ platform: 'discord', agentId: AGENT, discord: { botToken: 'MTA1.b.c', applicationId: 'A1' } })
    ).toBe(true)
    expect(
      accepts({
        platform: 'feishu',
        agentId: AGENT,
        transport: 'http',
        feishu: { appId: 'cli_x', appSecret: 's', region: 'feishu', verificationToken: 'v', encryptKey: 'e' }
      })
    ).toBe(true)
  })

  it('defaults an omitted feishu region to Lark and drops unknown keys (non-strict)', () => {
    const parsed = Body.parse({ platform: 'feishu', agentId: AGENT, feishu: { appId: 'cli_x', appSecret: 's' }, zz: 1 })
    expect(parsed).toMatchObject({ platform: 'feishu', agentId: AGENT, feishu: { region: 'lark' } })
    expect(parsed).not.toHaveProperty('zz')
  })
})

describe('composed create-integration body: rejects what the closed union rejected', () => {
  it('requires exactly one of botId or the platform’s credential block', () => {
    expect(messages({ platform: 'slack', agentId: AGENT })).toContain('exactly one of botId or slack must be provided')
    expect(messages({ platform: 'telegram', agentId: AGENT, botId: BOT, telegram: { botToken: '123:abc' } })).toContain(
      'exactly one of botId or telegram must be provided'
    )
  })

  it('rejects a credential block that belongs to another platform', () => {
    expect(messages({ platform: 'telegram', agentId: AGENT, slack: { botToken: 'xoxb-1' } })).toContain(
      'slack credentials given for a telegram integration'
    )
    // Both wrong blocks are reported, and the exactly-one-of rule still fires.
    const both = messages({ platform: 'feishu', agentId: AGENT, discord: { botToken: 'd' }, slack: { botToken: 'x' } })
    expect(both).toContain('discord credentials given for a feishu integration')
    expect(both).toContain('slack credentials given for a feishu integration')
    expect(both).toContain('exactly one of botId or feishu must be provided')
  })

  it('enforces the per-transport credential requirements of slack and feishu', () => {
    const base = { platform: 'slack', agentId: AGENT }
    expect(messages({ ...base, transport: 'http', slack: { botToken: 'xoxb-1' } })).toContain(
      'http transport requires slack.signingSecret'
    )
    // An omitted transport is the create route's socket default.
    expect(messages({ ...base, slack: { botToken: 'xoxb-1' } })).toContain('socket transport requires slack.appToken')
    expect(messages({ ...base, transport: 'socket', slack: { botToken: 'xoxb-1' } })).toContain(
      'socket transport requires slack.appToken'
    )
    expect(
      messages({ platform: 'feishu', agentId: AGENT, transport: 'http', feishu: { appId: 'cli_x', appSecret: 's' } })
    ).toContain('http transport requires feishu.verificationToken')
  })

  it('does not run the transport refinements when an existing bot is reused', () => {
    expect(accepts({ platform: 'slack', agentId: AGENT, botId: BOT, transport: 'http' })).toBe(true)
    expect(accepts({ platform: 'feishu', agentId: AGENT, botId: BOT, transport: 'http' })).toBe(true)
  })

  it('rejects a missing secret inside a credential block', () => {
    expect(accepts({ platform: 'telegram', agentId: AGENT, telegram: {} })).toBe(false)
    expect(accepts({ platform: 'telegram', agentId: AGENT, telegram: { botToken: '' } })).toBe(false)
    expect(accepts({ platform: 'slack', agentId: AGENT, slack: { appToken: 'xapp-1' } })).toBe(false)
    expect(accepts({ platform: 'feishu', agentId: AGENT, feishu: { appId: 'cli_x' } })).toBe(false)
    expect(
      accepts({ platform: 'feishu', agentId: AGENT, feishu: { appId: 'cli_x', appSecret: 's', region: 'qq' } })
    ).toBe(false)
  })

  it('rejects an unregistered platform, a bad transport, and a missing agent', () => {
    expect(accepts({ platform: 'mastodon', agentId: AGENT, mastodon: { botToken: 't' } })).toBe(false)
    expect(accepts({ agentId: AGENT, botId: BOT })).toBe(false)
    expect(accepts({ platform: 'slack', agentId: AGENT, botId: BOT, transport: 'websocket' })).toBe(false)
    expect(accepts({ platform: 'slack', botId: BOT })).toBe(false)
    expect(accepts({ platform: 'slack', agentId: '', botId: BOT })).toBe(false)
    expect(accepts({ platform: 'slack', agentId: AGENT, botId: BOT, name: '' })).toBe(false)
    expect(accepts({ platform: 'slack', agentId: AGENT, botId: BOT, shareable: 'yes' })).toBe(false)
  })
})

describe('the composition IS the platform-set authority', () => {
  /** A minimal fifth provider — only the members the composition reads are
   *  meaningful; the rest satisfy the contract without being exercised. */
  function mastodonProvider(): CpPlatformProvider<{ accessToken: string }> {
    return {
      platformId: 'mastodon',
      installRoutes: () => [],
      credentialBodySchema: z.object({ accessToken: z.string().min(1) }),
      refineCreateBody: ({ credentials, transport }, addIssue) => {
        if (transport === 'http' && !credentials.accessToken.startsWith('http-')) {
          addIssue('http transport requires an http-scoped mastodon.accessToken')
        }
      },
      validateConfig: async () => ({ ok: true, identity: {} }),
      buildNewBotInstall: ({ credentials }) => ({
        secrets: { botToken: credentials.accessToken, appToken: null, signingSecret: null }
      }),
      secretShape: { slots: { botToken: 'Mastodon access token' }, httpAssignRequires: [] },
      projectIntegrationConfig: async () => ({})
    }
  }

  it('extends the wire with a newly registered provider — no edit to the composition', () => {
    const Extended = buildCreateIntegrationBody(
      buildCpPlatformRegistry([createSlackCpProvider({}), mastodonProvider()])
    )
    expect(Extended.safeParse({ platform: 'mastodon', agentId: AGENT, mastodon: { accessToken: 'a' } }).success).toBe(
      true
    )
    // The new platform inherits every cross-block rule for free…
    const mismatch = Extended.safeParse({ platform: 'mastodon', agentId: AGENT, slack: { botToken: 'xoxb-1' } })
    expect(mismatch.success).toBe(false)
    expect(!mismatch.success && mismatch.error.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'slack credentials given for a mastodon integration',
        'exactly one of botId or mastodon must be provided'
      ])
    )
    // …and contributes its own transport refinement through the same seam.
    const badTransport = Extended.safeParse({
      platform: 'mastodon',
      agentId: AGENT,
      transport: 'http',
      mastodon: { accessToken: 'a' }
    })
    expect(!badTransport.success && badTransport.error.issues[0]?.message).toBe(
      'http transport requires an http-scoped mastodon.accessToken'
    )
    // A platform the registry does NOT hold is not on the wire at all.
    expect(Extended.safeParse({ platform: 'telegram', agentId: AGENT, botId: BOT }).success).toBe(false)
  })

  it('hands the chosen platform’s block back opaquely, and undefined when a bot is reused', () => {
    expect(
      credentialBlockOf(Body.parse({ platform: 'telegram', agentId: AGENT, telegram: { botToken: 't' } }))
    ).toEqual({ botToken: 't' })
    expect(credentialBlockOf(Body.parse({ platform: 'slack', agentId: AGENT, botId: BOT }))).toBeUndefined()
  })

  it('refuses to compose a body with no registered platform, or an id that shadows a core field', () => {
    expect(() => buildCreateIntegrationBody(buildCpPlatformRegistry([]))).toThrow(/no platform provider is registered/)
    const shadow: CpPlatformProvider = { ...mastodonProvider(), platformId: 'transport' }
    expect(() => buildCreateIntegrationBody(buildCpPlatformRegistry([shadow]))).toThrow(/collides with a core/)
  })
})

describe('the generated OpenAPI document still enumerates every platform variant', () => {
  /** Only `config` is read at build time; the create route additionally folds
   *  the registry into its body schema at plugin-registration time. */
  function stubDeps(): HttpDeps {
    return {
      repos: { user: { provisionOidcUser: async () => ({ userId: 'u' }) } },
      config: { NODE_ENV: 'test', DEFAULT_OWNER_ID: '00000000-0000-4000-8000-000000000000' },
      platforms: offlinePlatforms()
    } as unknown as HttpDeps
  }

  async function createIntegrationOperation(): Promise<Record<string, any>> {
    const app: FastifyInstance = buildHttpServer(stubDeps())
    try {
      await app.ready()
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      return doc.paths?.['/api/v1/orgs/{orgId}/integrations']?.post
    } finally {
      await app.close()
    }
  }

  it('documents one request-body property per registered platform, with its own fields', async () => {
    const op = await createIntegrationOperation()
    const schema = op?.requestBody?.content?.['application/json']?.schema
    expect(schema?.properties?.platform?.enum?.slice().sort()).toEqual(['discord', 'feishu', 'slack', 'telegram'])
    expect(Object.keys(schema?.properties ?? {})).toEqual(
      expect.arrayContaining(['slack', 'telegram', 'discord', 'feishu'])
    )
    expect(Object.keys(schema?.properties?.slack?.properties ?? {}).sort()).toEqual([
      'appToken',
      'botToken',
      'signingSecret'
    ])
    expect(Object.keys(schema?.properties?.telegram?.properties ?? {})).toEqual(['botToken'])
    expect(Object.keys(schema?.properties?.discord?.properties ?? {}).sort()).toEqual(['applicationId', 'botToken'])
    expect(Object.keys(schema?.properties?.feishu?.properties ?? {}).sort()).toEqual([
      'appId',
      'appSecret',
      'encryptKey',
      'region',
      'verificationToken'
    ])
    // Credentials are the only optional half: the core skeleton stays required.
    expect(schema?.required?.slice().sort()).toEqual(['agentId', 'platform'])
  })

  it('keeps the repo’s OpenAPI conventions on the route (docs UI renders a named, grouped operation)', async () => {
    const op = await createIntegrationOperation()
    expect(op).toMatchObject({ operationId: 'createIntegration', tags: ['Integrations'] })
    expect(op?.summary).toBeTruthy()
    expect(op?.description).toBeTruthy()
  })

  it('tolerates the container’s LATE-BOUND registry — nothing reads `platforms` before ready()', async () => {
    // `buildContainer` builds the Fastify instance BEFORE the providers exist
    // (their funnel plugins close over the very dep bundle being assembled), so
    // it publishes the registry through a getter that throws until composition
    // finishes. Reproduce that exact ordering: an eager read anywhere between
    // `buildHttpServer` and `ready()` would crash the CP at boot while every
    // plain-field test harness — including the integration one — stayed green.
    // Mirrors `container.ts`'s declaration exactly, guard and all.
    let composed: CpPlatformRegistry | undefined = undefined
    const lateBound = {
      repos: { user: { provisionOidcUser: async () => ({ userId: 'u' }) } },
      config: { NODE_ENV: 'test', DEFAULT_OWNER_ID: '00000000-0000-4000-8000-000000000000' },
      get platforms(): CpPlatformRegistry {
        if (!composed) throw new Error('platform registry read before composition')
        return composed
      }
    } as unknown as HttpDeps

    const app: FastifyInstance = buildHttpServer(lateBound) // must not touch `platforms`…
    composed = offlinePlatforms() // …the container assigns here, before listen()
    try {
      await app.ready()
      const doc = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as Record<string, any>
      const schema =
        doc.paths?.['/api/v1/orgs/{orgId}/integrations']?.post?.requestBody?.content?.['application/json']?.schema
      expect(schema?.properties?.platform?.enum?.slice().sort()).toEqual(['discord', 'feishu', 'slack', 'telegram'])
    } finally {
      await app.close()
    }
  })
})
