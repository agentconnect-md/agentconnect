/**
 * §14.8 seeding policy (resource-visibility.md): which of a private agent's reported
 * conversations open to the ordinary DM default because their counterpart is already
 * in the agent's audience. Both arms of the rule are load-bearing — an unlinked
 * audience member and a linked non-member must BOTH keep §14.2's Off — and every
 * unresolvable case has to fail to Off rather than to open.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentRecord, BotRecord, ReportedChannel } from '../persistence/ports.js'
import type { SlackIdentity } from '../github/logto-identity.js'
import { gatedDmSeeds, linkedAudienceMemberIds, type LinkedDmDeps } from './linkedDm.js'

const TEAM = 'T024BE7LD'

const agent = (over: Partial<Pick<AgentRecord, 'visibility' | 'sharedWith'>> = {}) => ({
  visibility: 'restricted' as const,
  sharedWith: ['user-a'],
  ...over
})

const bot = (over: Partial<Pick<BotRecord, 'platform' | 'teamId'>> = {}) => ({
  platform: 'slack',
  teamId: TEAM,
  ...over
})

/** `links` maps a user id to the Slack identity their console account carries. */
function deps(links: Record<string, SlackIdentity | null>, over: Partial<LinkedDmDeps> = {}): LinkedDmDeps {
  return {
    users: { getOidcSubject: async (userId) => (userId in links ? `sub-${userId}` : null) },
    identity: {
      slackIdentityFor: async (sub) => links[sub.replace(/^sub-/, '')] ?? null
    },
    ...over
  }
}

const slack = (userId: string, teamId = TEAM): SlackIdentity => ({ teamId, userId })

describe('linkedAudienceMemberIds', () => {
  it('resolves every audience member who linked this workspace', async () => {
    const ids = await linkedAudienceMemberIds(
      agent({ sharedWith: ['user-a', 'user-b', 'user-c'] }),
      bot(),
      deps({ 'user-a': slack('U_A'), 'user-b': slack('U_B'), 'user-c': slack('U_C') })
    )
    expect([...ids].sort()).toEqual(['U_A', 'U_B', 'U_C'])
  })

  it('leaves out an audience member who never linked', async () => {
    const ids = await linkedAudienceMemberIds(
      agent({ sharedWith: ['user-a', 'user-b'] }),
      bot(),
      deps({ 'user-a': slack('U_A'), 'user-b': null })
    )
    expect([...ids]).toEqual(['U_A'])
  })

  it('fences on the workspace — the same member id in another team is another person', async () => {
    const ids = await linkedAudienceMemberIds(agent(), bot(), deps({ 'user-a': slack('U_A', 'T_OTHER') }))
    expect(ids.size).toBe(0)
  })

  it('resolves nothing for a public agent, an unknown workspace, or a deployment without sign-in', async () => {
    const links = { 'user-a': slack('U_A') }
    expect((await linkedAudienceMemberIds(agent({ visibility: 'org' }), bot(), deps(links))).size).toBe(0)
    expect((await linkedAudienceMemberIds(agent(), bot({ teamId: null }), deps(links))).size).toBe(0)
    expect((await linkedAudienceMemberIds(agent(), bot({ platform: 'telegram' }), deps(links))).size).toBe(0)
    expect((await linkedAudienceMemberIds(agent(), bot(), { users: deps(links).users })).size).toBe(0)
  })

  it('keeps the Off default when one member’s lookup throws, without losing the others', async () => {
    const warn = vi.fn()
    const ids = await linkedAudienceMemberIds(agent({ sharedWith: ['user-a', 'user-b'] }), bot(), {
      users: { getOidcSubject: async (userId) => `sub-${userId}` },
      identity: {
        slackIdentityFor: async (sub) => {
          if (sub === 'sub-user-a') throw new Error('logto unreachable')
          return slack('U_B')
        }
      },
      log: { debug: vi.fn(), warn }
    })
    expect([...ids]).toEqual(['U_B'])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('refuses an audience too large to resolve rather than fanning it out upstream', async () => {
    const slackIdentityFor = vi.fn(async () => slack('U_A'))
    const ids = await linkedAudienceMemberIds(
      agent({ sharedWith: Array.from({ length: 201 }, (_, i) => `user-${i}`) }),
      bot(),
      {
        users: { getOidcSubject: async (userId) => `sub-${userId}` },
        identity: { slackIdentityFor },
        log: { debug: vi.fn(), warn: vi.fn() }
      }
    )
    expect(ids.size).toBe(0)
    expect(slackIdentityFor).not.toHaveBeenCalled()
  })
})

describe('gatedDmSeeds', () => {
  const dm = (id: string, dmUserId: string): ReportedChannel => ({ id, kind: 'im', dmUserId })

  it('opens the DM of an audience member and leaves everyone else Off', async () => {
    const seeds = await gatedDmSeeds(
      [dm('D_A', 'U_A'), dm('D_STRANGER', 'U_STRANGER')],
      agent({ sharedWith: ['user-a'] }),
      bot(),
      deps({ 'user-a': slack('U_A') })
    )
    expect([...seeds]).toEqual([['D_A', 'any']])
  })

  it('opens one row per audience member of the same agent', async () => {
    const seeds = await gatedDmSeeds(
      [dm('D_A', 'U_A'), dm('D_B', 'U_B'), dm('D_C', 'U_C')],
      agent({ sharedWith: ['user-a', 'user-b', 'user-c'] }),
      bot(),
      deps({ 'user-a': slack('U_A'), 'user-b': slack('U_B'), 'user-c': slack('U_C') })
    )
    expect([...seeds].sort()).toEqual([
      ['D_A', 'any'],
      ['D_B', 'any'],
      ['D_C', 'any']
    ])
  })

  it('never seeds a channel or a group DM — their membership is a room, not a person', async () => {
    const seeds = await gatedDmSeeds(
      [
        { id: 'C_DEPLOYS', kind: 'channel' },
        { id: 'G_ROOM', kind: 'mpim', dmUserId: 'U_A' }
      ],
      agent(),
      bot(),
      deps({ 'user-a': slack('U_A') })
    )
    expect(seeds.size).toBe(0)
  })

  it('costs no identity lookup when the report carries no DM to seed', async () => {
    const getOidcSubject = vi.fn(async () => 'sub-user-a')
    const seeds = await gatedDmSeeds([{ id: 'C_DEPLOYS', kind: 'channel' }], agent(), bot(), {
      users: { getOidcSubject },
      identity: { slackIdentityFor: async () => slack('U_A') }
    })
    expect(seeds.size).toBe(0)
    expect(getOidcSubject).not.toHaveBeenCalled()
  })

  it('leaves a DM reported without its counterpart Off', async () => {
    const seeds = await gatedDmSeeds([{ id: 'D_A', kind: 'im' }], agent(), bot(), deps({ 'user-a': slack('U_A') }))
    expect(seeds.size).toBe(0)
  })
})
