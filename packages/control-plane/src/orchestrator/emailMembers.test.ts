import { describe, expect, it, vi } from 'vitest'
import type { AgentRecord, IntegrationRecord, OrgMemberRecord } from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { resolveEmailMembers, type EmailMembersDeps } from './emailMembers.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const ORG = 'org-a'

const member = (userId: string, role: OrgMemberRecord['role'] = 'collaborator') => ({ userId, role }) as OrgMemberRecord

function deps(
  agent: Partial<AgentRecord> | null,
  byAddress: Record<string, OrgMemberRecord>,
  platforms: string[] = ['email']
): EmailMembersDeps & { users: { memberByVerifiedEmail: ReturnType<typeof vi.fn> } } {
  return {
    agent: {
      getUnscoped: async () =>
        agent ? ({ id: AGENT_ID, orgId: ORG, visibility: 'org', sharedWith: [], ...agent } as AgentRecord) : null
    },
    integration: { activeForAgents: async () => platforms.map((platform) => ({ platform }) as IntegrationRecord) },
    users: {
      memberByVerifiedEmail: vi.fn(async (orgId: string, email: string) =>
        orgId === ORG ? (byAddress[email] ?? null) : null
      )
    }
  }
}

const ask = (addresses: string[]) => ({ agentId: AGENT_ID, addresses })

describe('resolveEmailMembers (email-integration.md §4 step 3)', () => {
  it('admits a verified member of an agent open to its organization, with their console user', async () => {
    const d = deps({}, { 'alice@corp.example.test': member('user-alice', 'viewer') })
    expect(await resolveEmailMembers(ask(['alice@corp.example.test']), d, ORG)).toEqual({
      members: [{ address: 'alice@corp.example.test', consoleUserId: 'user-alice' }]
    })
  })

  it('answers a batch with the admitted addresses only, each asked once', async () => {
    const d = deps(
      { visibility: 'restricted', sharedWith: ['user-alice'] },
      {
        'alice@corp.example.test': member('user-alice'),
        'bob@corp.example.test': member('user-bob'),
        'owner@corp.example.test': member('user-owner', 'owner')
      }
    )
    const answer = await resolveEmailMembers(
      ask([
        'alice@corp.example.test',
        'bob@corp.example.test',
        'owner@corp.example.test',
        'stranger@other.example.test',
        'alice@corp.example.test'
      ]),
      d,
      ORG
    )
    // Bob is a member the restricted agent's list leaves out; an owner sees every agent, as in the console.
    expect(answer.members).toEqual([
      { address: 'alice@corp.example.test', consoleUserId: 'user-alice' },
      { address: 'owner@corp.example.test', consoleUserId: 'user-owner' }
    ])
    expect(d.users.memberByVerifiedEmail).toHaveBeenCalledTimes(4)
  })

  it('admits nobody for an agent of another organization, an unknown agent, or one with no address', async () => {
    const known = { 'alice@corp.example.test': member('user-alice') }
    const question = ask(['alice@corp.example.test'])
    expect(await resolveEmailMembers(question, deps({ orgId: OrgId('org-b') }, known), ORG)).toEqual({ members: [] })
    expect(await resolveEmailMembers(question, deps(null, known), ORG)).toEqual({ members: [] })
    const noAddress = deps({}, known, ['slack'])
    expect(await resolveEmailMembers(question, noAddress, ORG)).toEqual({ members: [] })
    expect(noAddress.users.memberByVerifiedEmail).not.toHaveBeenCalled()
  })

  it('lets a failed read fail the whole answer, so nothing is admitted on a guess', async () => {
    const d = deps({}, {})
    d.users.memberByVerifiedEmail.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(resolveEmailMembers(ask(['alice@corp.example.test']), d, ORG)).rejects.toThrow('db unavailable')
  })
})
