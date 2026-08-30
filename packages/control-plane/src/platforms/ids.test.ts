/**
 * The platform-set authority (S3 exit criterion; audit F8, F10, F11).
 *
 * Before this, the served set was spelled SIX times in the control plane: the
 * persistence fence's `DB_PLATFORMS`, the cron/hook `Platform` enum, the MCP
 * `upsertCron` enum, two inline unions in `hooks.ts`, and the waitlist intake —
 * which had already drifted, sitting at three ids after Feishu shipped. Each
 * consumer now reads {@link CP_PLATFORM_IDS}, and the load-bearing claim of the
 * whole arrangement is the FIRST test below: the static declaration is what the
 * production providers register, so adding a platform is one entry plus a
 * provider and no consumer edit at all.
 *
 * The rest pin the consumers to that declaration. They are deliberately written
 * as "this surface's vocabulary EQUALS the declaration", not as "…contains
 * feishu": a re-introduced hand list that happens to be correct today still
 * fails, because it is the copy that is the defect.
 */
import { describe, it, expect } from 'vitest'
import type { Platform as ProtocolPlatform } from '@agentconnect.md/protocol'
import { CP_PLATFORM_IDS } from './ids.js'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'
import { toDbPlatform } from '../persistence/platform.js'
import { Platform, UpsertCronBody, WaitlistJoinBody } from '../http/dto/index.js'
import { findTool } from '../http/mcp/tools.js'

/** The four providers `container.ts` composes, with offline stub seams — the
 *  same construction `env.test.ts` uses to read declarations off the real
 *  provider objects. */
const productionRegistry = buildCpPlatformRegistry([
  createTelegramCpProvider({ verifyBot: async () => ({ status: 'unreachable' }) }),
  createDiscordCpProvider({ ensureMessageContentIntent: async () => 'ready' }),
  createSlackCpProvider({}),
  createFeishuCpProvider({})
])

const sorted = [...CP_PLATFORM_IDS].sort()

describe('CP_PLATFORM_IDS', () => {
  it('is exactly the set the production providers register', () => {
    // The whole point: a provider added to the container and forgotten here (or
    // an id left here after its provider went away) fails HERE, not silently in
    // the cron vocabulary, the waitlist intake, and the persistence fence.
    expect([...productionRegistry.ids()].sort()).toEqual(sorted)
  })

  it('excludes the session-identity-only platforms', () => {
    // `webchat`, `hook` and `dream` are protocol platforms with no provider, no
    // persisted integration row and no install funnel. They must never reach a
    // surface keyed on this list.
    for (const p of ['webchat', 'hook', 'dream']) {
      expect(CP_PLATFORM_IDS as readonly string[]).not.toContain(p)
    }
  })
})

describe('the persistence fence (F8)', () => {
  it('serves exactly the declared set', () => {
    for (const id of CP_PLATFORM_IDS) expect(toDbPlatform(id)).toBe(id)
  })

  it('still throws — the fence survived the list swap', () => {
    // Two distinct refusals, both load-bearing: the DB columns are open TEXT, so
    // this helper is the only thing standing between a stray id and a row.
    expect(() => toDbPlatform('webchat' as ProtocolPlatform)).toThrow(/session-identity platform/)
    expect(() => toDbPlatform('mastodon' as ProtocolPlatform)).toThrow(/unknown platform/)
  })
})

describe('the cron / hook target vocabulary (F10)', () => {
  it('is the declaration, in the REST body', () => {
    expect([...Platform.options].sort()).toEqual(sorted)
  })

  it('is the declaration, in the MCP upsertCron tool', () => {
    // Read behaviorally rather than by introspecting the tool's zod internals:
    // every declared id parses, and an unregistered one does not.
    const tool = findTool('upsertCron')
    if (!tool) throw new Error('upsertCron tool missing')
    const args = (targetPlatform: string) => ({
      agentId: '00000000-0000-4000-8000-000000000001',
      schedule: '0 9 * * *',
      trigger: 'go',
      // Required by the tool; this case is about the platform vocabulary, not the clock.
      timezone: 'UTC',
      targetPlatform
    })
    for (const id of CP_PLATFORM_IDS) expect(tool.schema.safeParse(args(id)).success).toBe(true)
    expect(tool.schema.safeParse(args('mastodon')).success).toBe(false)
  })

  it('keeps the `slack` default an envelope legacy value, not a registry read', () => {
    // Audit §6.8 / ambiguous row 7: a cron stored before `targetPlatform`
    // existed reads back as Slack. The MEMBERS track the registry; this DEFAULT
    // describes the historical shape of stored rows and must not move when a
    // platform is registered ahead of Slack.
    const parsed = UpsertCronBody.parse({
      agentId: '00000000-0000-4000-8000-000000000001',
      schedule: '0 9 * * *',
      trigger: 'go'
    })
    expect(parsed.targetPlatform).toBe('slack')
  })
})

describe('the waitlist intake set (F11)', () => {
  const intake = (platform: string[]) => ({
    name: 'Ada',
    company: 'Northwind Ops',
    platform,
    teamSize: '2-10'
  })

  it('tracks the registry — every served platform is selectable', () => {
    // DECIDED in F11: intake asks "which of the platforms we serve will you
    // use", so its vocabulary IS the served set. The old hand copy proved the
    // point by drifting one id behind.
    for (const id of CP_PLATFORM_IDS) expect(WaitlistJoinBody.safeParse(intake([id])).success).toBe(true)
    expect(WaitlistJoinBody.safeParse(intake(['mastodon'])).success).toBe(false)
  })

  it('caps the selection at the registry size, not a hand-written count', () => {
    // The `.max(3)` this replaced was a second spelling of the same list length
    // and would have rejected an all-platforms answer the moment a fourth id
    // became selectable.
    expect(WaitlistJoinBody.safeParse(intake([...CP_PLATFORM_IDS])).success).toBe(true)
    expect(WaitlistJoinBody.safeParse(intake([])).success).toBe(false)
  })
})
