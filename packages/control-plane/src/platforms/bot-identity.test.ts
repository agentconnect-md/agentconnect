/**
 * The D6 identity projection (§11; audit F13).
 *
 * `PgBotRepo.create`'s four-arm `switch (input.platform)` decided which columns
 * carry a bot's demux identity and which write the tenantless sentinel — the
 * per-platform knowledge in shared persistence that §12 names. The switch is now
 * `CpPlatformProvider.projectBotIdentity`, and what these tests protect is the
 * INVARIANT the fence rests on, not the refactor: §11 reserves NULL for legacy
 * rows, so a new row of a platform that HAS an app identity must carry both
 * halves of the composite-unique pair, and a platform with no tenant axis must
 * write the sentinel rather than a NULL that would silently opt out of the
 * unique.
 *
 * Every case below is a projection of the SAME `CreateBotInput` the repository
 * receives, through the SAME four providers the container composes, asserted
 * with `toEqual` — an extra column is a failure, not a pass.
 */
import { describe, it, expect } from 'vitest'
import { botIdentityProjector } from './bot-identity.js'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'
import { TENANTLESS_SENTINEL, type CreateBotInput } from '../persistence/ports.js'
import { BotId, OrgId } from '../domain/ids.js'

const project = botIdentityProjector(
  buildCpPlatformRegistry([
    createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
    createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
    createSlackCpProvider({}),
    createFeishuCpProvider({})
  ])
)

/** The core-owned half of every bot write; the platform columns are the point. */
const row = (platform: string, columns: Partial<CreateBotInput> = {}): CreateBotInput => ({
  id: BotId('00000000-0000-4000-8000-0000000000b0'),
  orgId: OrgId('00000000-0000-4000-8000-0000000000a0'),
  platform,
  name: 'acme-bot',
  ...columns
})

describe('slack — tenant-scoped', () => {
  it('projects (slackAppId, teamId) as the generic pair', () => {
    // A platform-app OAuth install: both halves captured, so the pair is the
    // full demux identity and the composite unique fences on it.
    expect(project(row('slack', { slackAppId: 'A123', teamId: 'T999' }))).toEqual({
      externalAppId: 'A123',
      externalTenantId: 'T999'
    })
  })

  it('keeps each half independent — a manual install captures no workspace', () => {
    // Pasting tokens into the create form runs no OAuth exchange, so there is no
    // teamId to write. Postgres keeps those NULL rows distinct, which is why
    // Slack declares no 409 pre-check — there is nothing to pre-check.
    expect(project(row('slack', { slackAppId: 'A123' }))).toEqual({ externalAppId: 'A123' })
    expect(project(row('slack', { teamId: 'T999' }))).toEqual({ externalTenantId: 'T999' })
    expect(project(row('slack'))).toEqual({})
  })

  it('never writes the tenantless sentinel — Slack HAS a tenant axis', () => {
    // Writing `'-'` here would collapse every workspace of one app onto a single
    // unique key and refuse the second workspace's install.
    expect(project(row('slack', { slackAppId: 'A123' })).externalTenantId).toBeUndefined()
  })
})

describe('feishu — app-scoped, no tenant axis', () => {
  it('writes the app id plus the tenantless sentinel', () => {
    // The sentinel is what makes `(platform, externalAppId)` enforceable: a NULL
    // never participates in a composite unique, so a NULL tenant would silently
    // disable the one-bot-per-Feishu-app fence.
    expect(project(row('feishu', { feishuAppId: 'cli_abc', feishuRegion: 'lark' }))).toEqual({
      externalAppId: 'cli_abc',
      externalTenantId: TENANTLESS_SENTINEL,
      platformConfig: { feishuAppId: 'cli_abc', feishuRegion: 'lark' }
    })
    expect(TENANTLESS_SENTINEL).toBe('-')
  })

  it('carries the gateway region in the generic bag even alone', () => {
    // The region is the durable home that lets a freed bot reinstall against the
    // same gateway; it must survive the legacy columns being dropped.
    expect(project(row('feishu', { feishuRegion: 'feishu' }))).toEqual({
      platformConfig: { feishuRegion: 'feishu' }
    })
  })

  it('claims no identity without an app id', () => {
    expect(project(row('feishu'))).toEqual({})
  })
})

describe('discord — display metadata only', () => {
  it('writes the bag and leaves the fenced pair unset', () => {
    // The application id is a console deep link, not a demux key: Discord has no
    // HTTP callback ingress, so claiming uniqueness on it would fence nothing
    // and could refuse a legitimate second install.
    expect(project(row('discord', { discordAppId: '123456789012345678' }))).toEqual({
      platformConfig: { discordAppId: '123456789012345678' }
    })
  })

  it('writes nothing when the token carried no app id', () => {
    expect(project(row('discord'))).toEqual({})
  })
})

describe('telegram — no external identity at all', () => {
  it('projects nothing, declaring nothing', () => {
    // A bot token and nothing else. Absence of the provider member IS the
    // declaration; core must not invent an identity for it.
    expect(project(row('telegram'))).toEqual({})
  })

  it('ignores another platform’s columns if they ever arrive', () => {
    // Total by contract: the projection is the OWNING platform's, so a stray
    // column cannot leak a foreign identity onto the row.
    expect(project(row('telegram', { slackAppId: 'A123', discordAppId: '1' }))).toEqual({})
  })
})

describe('an unregistered platform', () => {
  it('projects nothing rather than guessing', () => {
    // The repository still WRITES (and still fences the row through
    // `toDbPlatform`); it simply has no identity to record.
    expect(project(row('mastodon', { slackAppId: 'A123' }))).toEqual({})
  })
})
