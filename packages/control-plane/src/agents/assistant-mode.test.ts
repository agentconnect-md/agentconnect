import { describe, expect, it } from 'vitest'
import { AssistantOnboarding } from '@agentconnect.md/protocol'
import {
  AssistantModeAdmissionRefused,
  anyAssistantModeAgent,
  assertAssistantModeDefinition,
  assistantModeAdmissionOf,
  assistantModeEditNeedsAdmission,
  assistantModePermissionModeForEdit,
  assistantModeRefusalMessage,
  assistantModeRoutedConversations,
  assistantModeStoreRefusals,
  assistantOnboardingForEdit,
  assistantOnboardingHints,
  memberEmailDomains,
  onboardingHintsFor,
  StoredAssistantModePolicyRow
} from './assistant-mode.js'
import { AgentId, OrgId } from '../domain/ids.js'
import type { AgentRecord, IntegrationChannelRecord, IntegrationRecord } from '../persistence/ports.js'

const ON = { enabled: true }
const OFF = { enabled: false }

function sets(orgId: string | null, stores: Array<string | null>) {
  return {
    get: async (id: string) => ({ id, orgId, name: 'group', spreadSessions: false }),
    memberContentStoresOf: async () => stores
  }
}

describe('assistant mode admission edges', () => {
  it('checks an edit that turns it on, or changes the definition while it is on', () => {
    expect(assistantModeEditNeedsAdmission(undefined, ON, false)).toBe(true)
    expect(assistantModeEditNeedsAdmission(OFF, ON, false)).toBe(true)
    expect(assistantModeEditNeedsAdmission(ON, { ...ON, instructions: 'x' }, false)).toBe(false)
    expect(assistantModeEditNeedsAdmission(ON, ON, true)).toBe(true)
    expect(assistantModeEditNeedsAdmission(ON, OFF, true)).toBe(false)
    expect(assistantModeEditNeedsAdmission(ON, null, true)).toBe(false)
  })

  it('throws every definition refusal at once', () => {
    expect(() => assertAssistantModeDefinition({ runtime: 'claude-acp', memory: null })).not.toThrow()
    expect(() => assertAssistantModeDefinition({ runtime: 'codex-acp', memory: null })).not.toThrow()
    expect(() =>
      assertAssistantModeDefinition({ runtime: 'opencode', memory: { provider: 'managed', home: 'daemon' } })
    ).not.toThrow()
    try {
      assertAssistantModeDefinition({ runtime: 'qwen-code', memory: { provider: 'native' } })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(AssistantModeAdmissionRefused)
      expect((e as AssistantModeAdmissionRefused).refusals).toEqual(['runtime-not-admitted', 'memory-provider'])
      expect((e as Error).message).toMatch(/^assistant mode cannot be turned on: .*memory must be managed$/)
    }
  })

  it('tells an edit to an agent already in the mode to turn it off first', () => {
    expect(() => assertAssistantModeDefinition({ runtime: 'claude-acp', memory: { provider: 'none' } }, true)).toThrow(
      'assistant mode is on, so this edit is refused: memory must be managed; turn assistant mode off first'
    )
  })

  it('needs one shared store across an org group, and nothing elsewhere', async () => {
    const placed = { placementKind: 'set' as const, setId: 'set-1' }
    expect(await assistantModeStoreRefusals(sets('org', ['s1', 's1']), placed)).toEqual([])
    expect(await assistantModeStoreRefusals(sets('org', ['s1', 's2']), placed)).toEqual(['store-not-shared'])
    expect(await assistantModeStoreRefusals(sets('org', [null, null]), placed)).toEqual(['store-not-shared'])
    expect(await assistantModeStoreRefusals(sets('org', []), placed)).toEqual([])
    expect(await assistantModeStoreRefusals(sets(null, [null, 's2']), placed)).toEqual([])
    expect(
      await assistantModeStoreRefusals(sets('org', ['s1', 's2']), { placementKind: 'daemon', setId: null })
    ).toEqual([])
  })
})

// assistant-mode.md §4.1, §5.18 ①: a By decision row, or a routed conversation of one of the agent's bots, fails the check.
describe('the routing check', () => {
  const gate = { type: 'gate', decisionId: 'decision-1', when: { type: 'boolean', values: [true] } }
  const routed = { type: 'shared_bot_routing' }
  const row = (integrationId: string, channelId: string, name: string | null, binding: unknown = null) =>
    ({
      integrationId,
      channelId,
      name,
      trigger: binding ? 'decision' : 'mention',
      decisionBinding: binding
    }) as unknown as IntegrationChannelRecord
  // The agent's own installs are int-a (bot-1) and int-b (bot-2); int-x and int-y are other agents' installs.
  const rowsByBot: Record<string, IntegrationChannelRecord[]> = {
    'bot-1': [
      row('int-a', 'C1', 'general', gate),
      row('int-a', 'C2', 'random'),
      row('int-x', 'C3', 'support', routed),
      row('int-x', 'C4', 'sales', gate)
    ],
    'bot-2': [row('int-b', 'C5', null, routed), row('int-y', 'C5', 'ops', routed)]
  }
  const repos = {
    memberSet: sets('org', []),
    integration: {
      listForAgent: async () =>
        [
          { id: 'int-a', botId: 'bot-1' },
          { id: 'int-b', botId: 'bot-2' }
        ] as unknown as IntegrationRecord[]
    },
    integrationChannel: { listForBot: async (botId: string) => rowsByBot[botId] ?? [] }
  }
  const agent = {
    id: AgentId('agent-1'),
    runtime: 'claude-acp',
    memory: null,
    placementKind: 'daemon' as const,
    setId: null
  }
  const named = [
    { integrationId: 'int-a', channelId: 'C1', name: 'general' },
    { integrationId: 'int-a', channelId: 'C3', name: 'support' },
    { integrationId: 'int-b', channelId: 'C5', name: 'ops' }
  ]

  it('names its own By decision rows and its bots’ routed conversations once each, never another agent’s gate', async () => {
    expect(await assistantModeRoutedConversations(repos, agent.id)).toEqual(named)
  })

  it('refuses the switch-on with the conversations, and skips the check for an agent already on', async () => {
    expect(await assistantModeAdmissionOf(repos, agent)).toEqual({
      admitted: false,
      refusals: ['routing'],
      conversations: named
    })
    expect(await assistantModeAdmissionOf(repos, agent, { routing: false })).toEqual({ admitted: true, refusals: [] })
    const clear = { ...repos, integrationChannel: { listForBot: async () => [row('int-a', 'C2', 'random')] } }
    expect(await assistantModeAdmissionOf(clear, agent)).toEqual({ admitted: true, refusals: [] })
  })

  it('names the conversations to change in the API message, by id where a name is unknown', () => {
    expect(
      assistantModeRefusalMessage(['memory-provider', 'routing'], false, [
        ...named.slice(0, 2),
        { integrationId: 'int-b', channelId: 'C5', name: null }
      ])
    ).toBe(
      'assistant mode cannot be turned on: memory must be managed; no conversation may be By decision or in a shared bot’s routing (change general, support, C5 first)'
    )
  })

  it('finds an agent in assistant mode among a conversation’s agents', async () => {
    const agents = {
      get: async (_org: OrgId, id: AgentId) =>
        ({ id, assistantMode: id === 'agent-on' ? { enabled: true } : { enabled: false } }) as unknown as AgentRecord
    }
    const org = OrgId('org-1')
    expect(await anyAssistantModeAgent(agents, org, [AgentId('agent-off'), AgentId('agent-on')])).toBe(true)
    expect(await anyAssistantModeAgent(agents, org, [AgentId('agent-off')])).toBe(false)
    expect(await anyAssistantModeAgent(agents, org, [])).toBe(false)
  })
})

describe('assistant mode permission default', () => {
  const claude = (permissionMode: string | null) => ({ runtime: 'claude-acp', permissionMode })

  it('applies only on the edit that turns it on', () => {
    expect(assistantModePermissionModeForEdit(undefined, ON, claude('default'), false)).toBe('auto')
    expect(assistantModePermissionModeForEdit(OFF, ON, claude(null), false)).toBe('auto')
    expect(assistantModePermissionModeForEdit(ON, { ...ON, instructions: 'x' }, claude('default'), false)).toBe(
      undefined
    )
    expect(assistantModePermissionModeForEdit(OFF, OFF, claude('default'), false)).toBeUndefined()
    expect(assistantModePermissionModeForEdit(ON, null, claude('default'), false)).toBeUndefined()
  })

  it('leaves a mode set in the same edit, and one that already runs unattended', () => {
    expect(assistantModePermissionModeForEdit(OFF, ON, claude('default'), true)).toBeUndefined()
    expect(assistantModePermissionModeForEdit(OFF, ON, claude('bypassPermissions'), false)).toBeUndefined()
    expect(
      assistantModePermissionModeForEdit(OFF, ON, { runtime: 'codex-acp', permissionMode: 'read-only' }, false)
    ).toBe('agent')
    expect(assistantModePermissionModeForEdit(OFF, ON, { runtime: 'opencode', permissionMode: 'plan' }, false)).toBe(
      undefined
    )
  })
})

describe('a stored assistant mode policy', () => {
  it('drops a removed key instead of failing the read', () => {
    const stored = {
      enabled: true,
      responsibleUserId: 'usr_1',
      patrolSchedule: '0 9 * * *',
      limits: { dailyCheckBudget: 5, dailySubsessionsPerItem: 3 }
    }
    expect(StoredAssistantModePolicyRow.parse(stored)).toEqual({ enabled: true, limits: { dailyCheckBudget: 5 } })
  })
})

describe('the onboarding record (assistant-mode.md §5.15)', () => {
  const now = new Date('2026-10-17T09:30:00.000Z')
  const hints = { organization: 'Example Org', emailDomains: ['example.test'] }

  it('is written by the first switch-on alone, naming the editor and when', () => {
    const record = assistantOnboardingForEdit(undefined, ON, false, { userId: 'usr_1', hints, now })
    expect(record).toEqual({ enabledByUserId: 'usr_1', enabledAt: '2026-10-17T09:30:00.000Z', hints })
    expect(AssistantOnboarding.parse(record)).toEqual(record)
    expect(assistantOnboardingForEdit(OFF, ON, false, { now })).toEqual({ enabledAt: '2026-10-17T09:30:00.000Z' })
  })

  it('is never written again: switching off and on later, or an edit while on, records nothing', () => {
    expect(assistantOnboardingForEdit(OFF, ON, true, { userId: 'usr_2', now })).toBeUndefined()
    expect(assistantOnboardingForEdit(ON, ON, false, { userId: 'usr_2', now })).toBeUndefined()
    expect(assistantOnboardingForEdit(ON, OFF, false, { userId: 'usr_2', now })).toBeUndefined()
    expect(assistantOnboardingForEdit(undefined, OFF, false, { userId: 'usr_2', now })).toBeUndefined()
  })

  it('keeps no empty hints', () => {
    expect(assistantOnboardingForEdit(undefined, ON, false, { hints: {}, now })).toEqual({
      enabledAt: '2026-10-17T09:30:00.000Z'
    })
  })
})

describe('research hints', () => {
  it('names the domains members use, most used first, and never an address or a public provider', () => {
    expect(
      memberEmailDomains([
        'alice@example.test',
        'bob@Example.Test',
        'carol@subsidiary.example',
        'dave@gmail.com',
        'erin@yahoo.co.uk',
        'frank@mail.yahoo.com',
        'grace@outlook.fr',
        null,
        'not-an-address'
      ])
    ).toEqual(['example.test', 'subsidiary.example'])
  })

  it('bounds every list and drops blank names', () => {
    const emails = Array.from({ length: 30 }, (_, i) => `person@domain-${i}.example`)
    const built = assistantOnboardingHints({
      organization: '  Example Org  ',
      workspaces: ['Example Workspace', 'Example Workspace', ' ', null, undefined],
      memberEmails: emails
    })
    expect(built.organization).toBe('Example Org')
    expect(built.workspaces).toEqual(['Example Workspace'])
    expect(built.emailDomains).toHaveLength(10)
    expect(assistantOnboardingHints({ organization: null, workspaces: [], memberEmails: [] })).toEqual({})
  })

  it('reads the organization through the editor’s membership, the agent’s bots and the members', async () => {
    const deps = {
      repos: {
        org: { listForUser: async () => [{ id: 'org-a', name: null, slug: 'example-org' }] },
        integration: { listForAgent: async () => [{ botId: 'bot-1' }, { botId: 'bot-2' }] },
        bot: {
          get: async (_org: string, id: string) => (id === 'bot-1' ? { workspaceName: 'Example Workspace' } : null)
        },
        user: { listMembers: async () => [{ email: 'alice@example.test' }, { email: null }] }
      }
    } as unknown as Parameters<typeof onboardingHintsFor>[0]
    const agent = { id: 'agent-a', orgId: 'org-a' } as Parameters<typeof onboardingHintsFor>[1]
    const hintsOf = (editor: string | undefined) => onboardingHintsFor(deps, agent, editor)
    await expect(hintsOf('usr_1')).resolves.toEqual({
      organization: 'example-org',
      workspaces: ['Example Workspace'],
      emailDomains: ['example.test']
    })
    await expect(hintsOf(undefined)).resolves.toEqual({
      workspaces: ['Example Workspace'],
      emailDomains: ['example.test']
    })
  })
})
