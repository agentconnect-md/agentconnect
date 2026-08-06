/**
 * Equivalence suite for the create tail's PLATFORM half (§9
 * `buildNewBotInstall`).
 *
 * `POST /integrations` used to carry four per-platform tails, each casting the
 * opaque credential block back to its own type and writing its own rows; core
 * now runs ONE skeleton (`http/install-bot.ts`) over what the provider returns.
 * The fixtures below are written from those tails' audited behavior — the bot
 * columns they filled, the two-slot secret packing (which Feishu OVERLOADS:
 * `botToken` = app secret, `appToken` = app id), the integration columns, and
 * the D6 identity fence — so a provider that maps a column differently fails
 * here rather than in production.
 *
 * The route-level equivalence (statuses, copy, ordering) is pinned end-to-end by
 * `test/integration/integrations.route.test.ts`; this suite pins the data.
 */
import { describe, it, expect } from 'vitest'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'
import type { CpValidatedIdentity } from './provider.js'

const NO_IDENTITY: CpValidatedIdentity = {}

describe('telegram buildNewBotInstall', () => {
  const provider = createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) })

  it('stores the single BotFather token with both other slots NULL, and no extra columns', () => {
    expect(
      provider.buildNewBotInstall({
        credentials: { botToken: '123:abc' },
        identity: { name: 'derived' },
        transport: 'socket',
        shareable: false
      })
    ).toEqual({ secrets: { botToken: '123:abc', appToken: null, signingSecret: null } })
  })

  it('never claims a D6 identity and never honors shareable', () => {
    const install = provider.buildNewBotInstall({
      credentials: { botToken: 't' },
      identity: NO_IDENTITY,
      transport: 'socket',
      shareable: true
    })
    expect(install.externalIdentity).toBeUndefined()
    expect(install.bot?.shareable).toBeUndefined()
  })
})

describe('discord buildNewBotInstall', () => {
  const provider = createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' })

  it('persists the application id the token decoded to, as public metadata', () => {
    expect(
      provider.buildNewBotInstall({
        credentials: { botToken: 'MTA1.bot.token' },
        identity: { name: 'derived', externalAppId: '105' },
        transport: 'socket',
        shareable: false
      })
    ).toEqual({
      bot: { discordAppId: '105' },
      secrets: { botToken: 'MTA1.bot.token', appToken: null, signingSecret: null }
    })
  })

  it('omits the column entirely when the token carried no decodable app id', () => {
    const install = provider.buildNewBotInstall({
      credentials: { botToken: 'opaque' },
      identity: NO_IDENTITY,
      transport: 'socket',
      shareable: false
    })
    expect(install.bot).toBeUndefined()
    expect(install.externalIdentity).toBeUndefined()
  })
})

describe('slack buildNewBotInstall', () => {
  const provider = createSlackCpProvider({})

  it('keeps the xapp-derived app id as the authority, and carries the workspace + mention metadata', () => {
    expect(
      provider.buildNewBotInstall({
        credentials: { botToken: 'xoxb-1', appToken: 'xapp-1-AXAPP-1-deadbeef' },
        identity: {
          name: 'acme',
          externalAppId: 'AAUTHTEST',
          workspaceId: 'T1',
          workspaceName: 'Acme',
          botUserId: 'U1'
        },
        transport: 'socket',
        shareable: false
      })
    ).toEqual({
      // `botUserId` is the member id exact channel mentions render (#601).
      bot: { slackAppId: 'AXAPP', workspaceId: 'T1', workspaceName: 'Acme', botUserId: 'U1' },
      secrets: { botToken: 'xoxb-1', appToken: 'xapp-1-AXAPP-1-deadbeef', signingSecret: null },
      // Workspace-claim admission fence (ingress-tenant-fence.md §5), keyed off
      // the SAME app-id authority as the row above — core refuses the create if
      // another org already runs this app in this workspace.
      workspaceClaim: {
        appId: 'AXAPP',
        tenantId: 'T1',
        conflictMessage: expect.stringContaining('already connected to another organization')
      }
    })
  })

  it('declares NO workspace claim when auth.test resolved no workspace (§3.3 fail-open)', () => {
    const built = provider.buildNewBotInstall({
      credentials: { botToken: 'xoxb-1', appToken: 'xapp-1-AXAPP-1-deadbeef' },
      identity: { name: 'acme' },
      transport: 'socket',
      shareable: false
    })
    // An install whose workspace could not be captured must still be creatable;
    // the relay's delivery fence is likewise open for it until the identity
    // reconciler backfills the workspace.
    expect(built.workspaceClaim).toBeUndefined()
  })

  it('falls back to the auth.test app id when there is no xapp to parse (http install)', () => {
    expect(
      provider.buildNewBotInstall({
        credentials: { botToken: 'xoxb-1', signingSecret: 'sig' },
        identity: { externalAppId: 'AAUTHTEST' },
        transport: 'http',
        shareable: true
      })
    ).toEqual({
      bot: { slackAppId: 'AAUTHTEST', shareable: true },
      secrets: { botToken: 'xoxb-1', appToken: null, signingSecret: 'sig' }
    })
  })

  it('omits every column the install did not learn, and never writes the demux teamId', () => {
    const install = provider.buildNewBotInstall({
      credentials: { botToken: 'xoxb-1' },
      identity: NO_IDENTITY,
      transport: 'socket',
      shareable: false
    })
    // `Bot.teamId` marks a DISTRIBUTED platform-app install and participates in
    // relay demux — a pasted-token install must never write one.
    expect(install.bot).toEqual({})
    expect(install.externalIdentity).toBeUndefined()
  })
})

describe('feishu buildNewBotInstall', () => {
  const provider = createFeishuCpProvider({})

  it('writes the app id + region on both rows and OVERLOADS the two secret slots', () => {
    expect(
      provider.buildNewBotInstall({
        credentials: { appId: 'cli_x', appSecret: 's3cret', region: 'lark' },
        identity: { name: 'derived', externalAppId: 'cli_x', botUserId: 'ou_bot' },
        transport: 'socket',
        shareable: false
      })
    ).toEqual({
      bot: { feishuAppId: 'cli_x', feishuRegion: 'lark', botUserId: 'ou_bot' },
      integration: { feishuRegion: 'lark' },
      secrets: {
        // botToken = the app SECRET; appToken = the app ID (the audited
        // overloading of the shared two-slot row).
        botToken: 's3cret',
        appToken: 'cli_x',
        signingSecret: null,
        verificationToken: null,
        encryptKey: null
      },
      externalIdentity: {
        externalAppId: 'cli_x',
        externalTenantId: '-',
        conflictMessage:
          'This Feishu app is already registered as a bot. Reuse that bot (pick it under "Existing") instead of registering the app again.'
      }
    })
  })

  it('carries the callback credentials for an http install', () => {
    const install = provider.buildNewBotInstall({
      credentials: {
        appId: 'cli_x',
        appSecret: 's3cret',
        region: 'feishu',
        verificationToken: 'vt',
        encryptKey: 'ek'
      },
      identity: { externalAppId: 'cli_x' },
      transport: 'http',
      shareable: true
    })
    expect(install.secrets.verificationToken).toBe('vt')
    expect(install.secrets.encryptKey).toBe('ek')
    expect(install.bot).toEqual({ feishuAppId: 'cli_x', feishuRegion: 'feishu' })
    // Feishu has no multi-agent sharing — the requested flag is dropped.
    expect(install.bot?.shareable).toBeUndefined()
  })

  it('fences the D6 identity with the tenantless sentinel', () => {
    const install = provider.buildNewBotInstall({
      credentials: { appId: 'cli_y', appSecret: 's', region: 'lark' },
      identity: NO_IDENTITY,
      transport: 'socket',
      shareable: false
    })
    // The pre-check query and the `BotExternalIdentityTaken` backstop both run
    // off this declaration, so the id and the sentinel must be exactly what the
    // repo's dual-write puts on the row.
    expect(install.externalIdentity?.externalAppId).toBe('cli_y')
    expect(install.externalIdentity?.externalTenantId).toBe('-')
  })
})
