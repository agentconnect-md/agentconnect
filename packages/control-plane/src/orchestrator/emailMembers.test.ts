import { describe, expect, it, vi } from 'vitest'
import type { AgentRecord, BotRecord, IntegrationRecord, OrgMemberRecord } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { resolveEmailMembers, type EmailMembersDeps } from './emailMembers.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const BOT_ID = '22222222-2222-4222-8222-222222222222'
const ORG = 'org-a'

const member = (userId: string, role: OrgMemberRecord['role'] = 'collaborator') => ({ userId, role }) as OrgMemberRecord

function deps(
  agent: Partial<AgentRecord> | null,
  byAddress: Record<string, OrgMemberRecord | OrgMemberRecord[]>,
  opts: { platforms?: string[]; settings?: Record<string, string>; creator?: string; active?: string[] } = {}
): EmailMembersDeps & {
  users: { verifiedEmailHolders: ReturnType<typeof vi.fn>; activeMember: ReturnType<typeof vi.fn> }
} {
  return {
    agent: {
      getUnscoped: async () =>
        agent ? ({ id: AGENT_ID, orgId: ORG, visibility: 'org', sharedWith: [], ...agent } as AgentRecord) : null
    },
    integration: {
      activeForAgents: async () =>
        (opts.platforms ?? ['email']).map(
          (platform) =>
            ({ platform, botId: BOT_ID, createdByUserId: opts.creator ?? 'user-adder' }) as IntegrationRecord
        )
    },
    bot: { getUnscoped: async () => ({ id: BOT_ID, platformConfig: opts.settings ?? null }) as BotRecord },
    users: {
      verifiedEmailHolders: vi.fn(async (orgId: string, email: string) => {
        const held = orgId === ORG ? byAddress[email] : undefined
        return held === undefined ? [] : Array.isArray(held) ? held : [held]
      }),
      activeMember: vi.fn(async (_orgId: string, userId: string) =>
        (opts.active ?? ['user-adder']).includes(userId) ? member(userId) : null
      )
    }
  }
}

const ask = (addresses: string[]) => ({ agentId: AGENT_ID, addresses })
const ANYONE = { whoMayWrite: 'anyone' }

describe('resolveEmailMembers (email-integration.md §4 step 3)', () => {
  it('admits a verified member of an agent open to its organization, with their console user', async () => {
    const d = deps({}, { 'alice@corp.example.test': member('user-alice', 'viewer') })
    expect(await resolveEmailMembers(ask(['alice@corp.example.test']), d, ORG)).toEqual({
      members: [{ address: 'alice@corp.example.test', consoleUserId: 'user-alice' }],
      outsiders: [],
      outsideSenders: 'refused'
    })
  })

  it('answers a batch: members, the addresses no member holds, and nothing for the rest', async () => {
    const d = deps(
      { visibility: 'restricted', sharedWith: ['user-alice'] },
      {
        'alice@corp.example.test': member('user-alice'),
        'bob@corp.example.test': member('user-bob'),
        'owner@corp.example.test': member('user-owner', 'owner'),
        'shared@corp.example.test': [member('user-x'), member('user-y')]
      }
    )
    const answer = await resolveEmailMembers(
      ask([
        'alice@corp.example.test',
        'bob@corp.example.test',
        'owner@corp.example.test',
        'shared@corp.example.test',
        'stranger@other.example.test',
        'alice@corp.example.test'
      ]),
      d,
      ORG
    )
    // Bob is a member the restricted agent's list leaves out; an owner sees every agent; two holders name neither.
    expect(answer.members).toEqual([
      { address: 'alice@corp.example.test', consoleUserId: 'user-alice' },
      { address: 'owner@corp.example.test', consoleUserId: 'user-owner' }
    ])
    expect(answer.outsiders).toEqual(['stranger@other.example.test'])
    expect(answer.outsideSenders).toBe('refused')
    expect(d.users.verifiedEmailHolders).toHaveBeenCalledTimes(5)
  })

  it('under Anyone admits outsiders while their sessions have somewhere to go, and recognizes every member', async () => {
    const known = { 'bob@corp.example.test': member('user-bob') }
    const question = ask(['bob@corp.example.test', 'stranger@other.example.test'])
    const restricted = { visibility: 'restricted' as const, sharedWith: [] }
    const open = await resolveEmailMembers(question, deps(restricted, known, { settings: ANYONE }), ORG)
    expect(open).toEqual({
      members: [{ address: 'bob@corp.example.test', consoleUserId: 'user-bob' }],
      outsiders: ['stranger@other.example.test'],
      outsideSenders: 'admitted'
    })
    const toOrg = deps({}, known, { settings: { ...ANYONE, outsideSessions: 'org' }, active: [] })
    expect((await resolveEmailMembers(question, toOrg, ORG)).outsideSenders).toBe('admitted')
    const picked = deps({}, known, {
      settings: { ...ANYONE, outsideSessions: 'user:user-carol' },
      active: ['user-carol']
    })
    expect((await resolveEmailMembers(question, picked, ORG)).outsideSenders).toBe('admitted')
  })

  it('refuses outsiders while the member their sessions go to is not active, never falling back on the organization', async () => {
    const question = ask(['stranger@other.example.test'])
    const departed = deps({}, {}, { settings: { ...ANYONE, outsideSessions: 'user:user-carol' }, active: [] })
    expect((await resolveEmailMembers(question, departed, ORG)).outsideSenders).toBe('refused')
    const gone = deps({}, {}, { settings: { ...ANYONE, outsideSessions: 'user:user-left' } })
    expect((await resolveEmailMembers(question, gone, ORG)).outsideSenders).toBe('refused')
  })

  it('admits outsiders by default, whose sessions go to the agent’s editors with no member to check', async () => {
    const question = ask(['stranger@other.example.test'])
    const d = deps({}, {}, { settings: ANYONE, active: [] })
    expect((await resolveEmailMembers(question, d, ORG)).outsideSenders).toBe('admitted')
    expect(d.users.activeMember).not.toHaveBeenCalled()
  })

  it('admits nobody for an agent of another organization, an unknown agent, or one with no address', async () => {
    const known = { 'alice@corp.example.test': member('user-alice') }
    const question = ask(['alice@corp.example.test'])
    const nobody = { members: [], outsiders: [], outsideSenders: 'refused' }
    expect(await resolveEmailMembers(question, deps({ orgId: OrgId('org-b') }, known), ORG)).toEqual(nobody)
    expect(await resolveEmailMembers(question, deps(null, known), ORG)).toEqual(nobody)
    const noAddress = deps({}, known, { platforms: ['slack'] })
    expect(await resolveEmailMembers(question, noAddress, ORG)).toEqual(nobody)
    expect(noAddress.users.verifiedEmailHolders).not.toHaveBeenCalled()
  })

  it('lets a failed read fail the whole answer, so nothing is admitted on a guess', async () => {
    const d = deps({}, {}, { settings: { ...ANYONE, outsideSessions: 'user:user-carol' }, active: ['user-carol'] })
    d.users.verifiedEmailHolders.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(resolveEmailMembers(ask(['stranger@other.example.test']), d, ORG)).rejects.toThrow('db unavailable')
    d.users.activeMember.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(resolveEmailMembers(ask(['stranger@other.example.test']), d, ORG)).rejects.toThrow('db unavailable')
  })
})
