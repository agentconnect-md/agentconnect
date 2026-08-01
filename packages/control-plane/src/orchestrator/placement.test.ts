/**
 * `integrationToSpec` — the per-channel trigger → wire bindRules fold (unit, no I/O).
 *
 * The delivered rule set is always: the defaults (@-mention anywhere + DMs) plus
 * one channel-scoped `auto` rule per channel switched to "any message". A channel
 * left on '@-mention' adds NO extra rule — the unscoped mention default covers it.
 */
import { describe, it, expect } from 'vitest'
import { integrationToSpec } from './placement.js'
import { agentRecordToSpec } from './agentSpecAssembler.js'
import type { AgentRecord, IntegrationChannelRecord, IntegrationRecord } from '../persistence/ports.js'
import { AgentId, IntegrationId, OrgId } from '../domain/ids.js'

const INTEGRATION: IntegrationRecord = {
  id: IntegrationId('66666666-6666-4666-8666-666666666666'),
  orgId: OrgId('org'),
  agentId: AgentId('77777777-7777-4777-8777-777777777777'),
  platform: 'slack',
  name: 'acme-bot',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z')
}
const SECRET = { botToken: 'xoxb-abc', appToken: 'xapp-def' }

const channel = (
  channelId: string,
  trigger: 'off' | 'mention' | 'any',
  kind: 'channel' | 'im' | 'mpim' = 'channel'
): IntegrationChannelRecord => ({
  integrationId: INTEGRATION.id,
  channelId,
  name: channelId.toLowerCase(),
  isPrivate: false,
  kind,
  trigger,
  agentId: null
})

describe('integrationToSpec bindRules', () => {
  it('defaults to mention + dm with no channels', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET)
    expect(spec.slack.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    expect(spec.slack.botToken).toBe(SECRET.botToken)
  })

  it("adds one channel-scoped 'auto' rule per 'any message' channel; 'mention' channels add none", () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [
      channel('C1', 'mention'),
      channel('C2', 'any'),
      channel('C3', 'any')
    ])
    expect(spec.slack.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C2', match: { kind: 'auto' } },
      { channel: 'C3', match: { kind: 'auto' } }
    ])
  })

  // §14.4: a direct row only exists because observation created it while the agent was
  // restricted, and the console hides it once the agent is org-visible. Compiling its
  // "any message" would leave the agent answering with no visible control to stop it.
  it('ignores a preserved DM / group-DM row set to "any" for a non-gated agent', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [
      channel('C1', 'any'),
      channel('D1', 'any', 'im'),
      channel('G1', 'any', 'mpim')
    ])
    expect(spec.slack.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: 'C1', match: { kind: 'auto' } }
    ])
  })

  it('emits a telegram-shaped spec (single botToken, no appToken) for a telegram integration', () => {
    const spec = integrationToSpec({ ...INTEGRATION, platform: 'telegram' }, { botToken: '123:abc', appToken: null }, [
      channel('-100', 'any')
    ])
    if (spec.platform !== 'telegram') throw new Error('expected telegram spec')
    expect(spec.telegram.botToken).toBe('123:abc')
    expect(spec).not.toHaveProperty('slack')
    expect(spec.telegram.bindRules).toEqual([
      { match: { kind: 'mention' } },
      { match: { kind: 'dm' } },
      { channel: '-100', match: { kind: 'auto' } }
    ])
  })
})

describe('integrationToSpec conversation gating (§14)', () => {
  it('gated: emits ONLY conversation-scoped rules — no unscoped defaults', () => {
    const spec = integrationToSpec(
      INTEGRATION,
      SECRET,
      [channel('C1', 'mention'), channel('C2', 'any'), channel('C3', 'off'), channel('D1', 'any', 'im')],
      true
    )
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.gated).toBe(true)
    expect(spec.slack.bindRules).toEqual([
      { channel: 'C1', match: { kind: 'mention' } },
      { channel: 'C2', match: { kind: 'auto' } },
      { channel: 'D1', match: { kind: 'dm' } }
    ])
  })

  it('gated with no enabled conversations ships an EMPTY rule set (fail-closed)', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [channel('C1', 'off'), channel('D1', 'off', 'im')], true)
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.bindRules).toEqual([])
    expect(spec.slack.gated).toBe(true)
  })

  it("non-gated: an 'off' channel keeps the defaults but is muted; gated is false", () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [channel('C1', 'off'), channel('D1', 'any', 'im')])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.gated).toBe(false)
    // The defaults are unscoped, so Off cannot be expressed by withholding a rule —
    // the fence is what silences C1. The im row adds no auto rule either; DMs are
    // covered by the unscoped dm default.
    expect(spec.slack.bindRules).toEqual([{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }])
    expect(spec.slack.mutedChannels).toEqual(['C1'])
  })
})

describe('integrationToSpec mutedChannels', () => {
  it('mutes every Off channel and nothing else', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [
      channel('C1', 'off'),
      channel('C2', 'mention'),
      channel('C3', 'any'),
      channel('C4', 'off')
    ])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.mutedChannels).toEqual(['C1', 'C4'])
  })

  // §14.4: the console hides a preserved direct row once its owner is org-visible, so
  // honouring its Off would silence DMs through a control nobody can see.
  it('never mutes a direct row on a non-gated integration', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [channel('D1', 'off', 'im'), channel('G1', 'off', 'mpim')])
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.mutedChannels).toEqual([])
  })

  // A gated integration says Off by having no rule for the conversation; stating it
  // twice would let the two representations drift apart.
  it('stays empty for a gated integration, whose Off is the missing rule', () => {
    const spec = integrationToSpec(INTEGRATION, SECRET, [channel('C1', 'off'), channel('C2', 'mention')], true)
    if (spec.platform !== 'slack') throw new Error('expected slack spec')
    expect(spec.slack.mutedChannels).toEqual([])
    expect(spec.slack.bindRules).toEqual([{ channel: 'C2', match: { kind: 'mention' } }])
  })

  it('rides every platform variant', () => {
    const tg = integrationToSpec({ ...INTEGRATION, platform: 'telegram' }, { botToken: '1:a', appToken: null }, [
      channel('-100', 'off')
    ])
    if (tg.platform !== 'telegram') throw new Error('expected telegram spec')
    expect(tg.telegram.mutedChannels).toEqual(['-100'])
    const dc = integrationToSpec({ ...INTEGRATION, platform: 'discord' }, { botToken: 'bot', appToken: null }, [
      channel('999', 'off')
    ])
    if (dc.platform !== 'discord') throw new Error('expected discord spec')
    expect(dc.discord.mutedChannels).toEqual(['999'])
    const fs = integrationToSpec({ ...INTEGRATION, platform: 'feishu' }, { botToken: 'sec', appToken: 'cli_x' }, [
      channel('oc_1', 'off')
    ])
    if (fs.platform !== 'feishu') throw new Error('expected feishu spec')
    expect(fs.feishu.mutedChannels).toEqual(['oc_1'])
  })
})

describe('agentRecordToSpec runtime overrides', () => {
  it('ships displayName as either its value or explicit null so clearing it replicates', () => {
    const agent: AgentRecord = {
      builtin: false,
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: null,
      pause: null,
      env: {},
      mcpServers: [],
      memory: null,
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    expect(agentRecordToSpec(agent, {})).toHaveProperty('displayName', 'Deploy Bot')
    expect(agentRecordToSpec({ ...agent, displayName: null }, {})).toHaveProperty('displayName', null)
    expect(agentRecordToSpec(agent, {}).workspace).toEqual({ mode: 'scratch', gitCredential: 'github-app' })
    // The preset marker always ships (definite record field) so the daemon can
    // gate preset-only capabilities (webchat_remote_mcp_v1) as soon as it syncs.
    expect(agentRecordToSpec(agent, {})).toHaveProperty('builtin', false)
    expect(agentRecordToSpec({ ...agent, builtin: true }, {})).toHaveProperty('builtin', true)
  })

  it('carries permissionMode to the daemon spec', () => {
    const agent: AgentRecord = {
      builtin: false,
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: 'plan',
      pause: null,
      env: {},
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    expect(agentRecordToSpec(agent, {})).toMatchObject({ permissionMode: 'plan' })
  })

  it('carries pause to the daemon spec, and omits it when null (#288)', () => {
    const base: AgentRecord = {
      builtin: false,
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: null,
      pause: true,
      env: {},
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    expect(agentRecordToSpec(base, {})).toMatchObject({ pause: true })
    // null ⇒ the key is omitted, so the daemon merge leaves the on-disk value alone.
    expect(agentRecordToSpec({ ...base, pause: null }, {})).not.toHaveProperty('pause')
    // #536: introduceOnJoin is a definite column value, always shipped so a toggle replicates.
    expect(agentRecordToSpec({ ...base, introduceOnJoin: true }, {})).toMatchObject({ introduceOnJoin: true })
    expect(agentRecordToSpec({ ...base, introduceOnJoin: false }, {})).toMatchObject({ introduceOnJoin: false })
  })

  it('carries the memory backend to the daemon spec, and omits it when null', () => {
    const base: AgentRecord = {
      builtin: false,
      id: AgentId('88888888-8888-4888-8888-888888888888'),
      orgId: OrgId('org'),
      name: 'mem-bot',
      displayName: 'Mem Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: null,
      pause: null,
      env: {},
      mcpServers: [],
      memory: { provider: 'native' },
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    expect(agentRecordToSpec(base, {})).toMatchObject({ memory: { provider: 'native' } })
    // null ⇒ omitted, so switching-then-clearing leaves the on-disk value alone.
    expect(agentRecordToSpec({ ...base, memory: null }, {})).not.toHaveProperty('memory')
  })

  it('ships a cleared model/effort/permissionMode as explicit null so a runtime switch replicates the clear', () => {
    const base: AgentRecord = {
      builtin: false,
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: null,
      pause: null,
      env: {},
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    // The bug: these were omitted when null, conflating "cleared to default" with
    // "leave alone", so the previous runtime's model survived in agent.json. They must
    // be present-and-null (like env/mcpServers) so the daemon merge deletes them.
    const spec = agentRecordToSpec(base, {})
    expect(spec).toHaveProperty('model', null)
    expect(spec).toHaveProperty('reasoningEffort', null)
    expect(spec).toHaveProperty('permissionMode', null)

    // A set value still rides through unchanged.
    expect(agentRecordToSpec({ ...base, model: 'opus' }, {})).toMatchObject({ model: 'opus' })
  })

  it('ships the caller-fetched secrets (AgentSecretStore) on the spec — even {} so a removed secret replicates', () => {
    const base: AgentRecord = {
      builtin: false,
      id: AgentId('77777777-7777-4777-8777-777777777777'),
      orgId: OrgId('org'),
      name: 'deploy-bot',
      displayName: 'Deploy Bot',
      description: null,
      runtime: 'claude-acp',
      model: null,
      reasoningEffort: null,
      outputMode: null,
      fastMode: null,
      permissionMode: null,
      pause: null,
      env: {},
      mcpServers: [],
      memory: null,
      status: 'active',
      daemonId: null,
      workspace: { mode: 'scratch' },
      capabilities: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      createdByUserId: null,
      ownerUserId: null,
      visibility: 'org',
      sharedWith: [],
      lastModifiedAt: new Date('2026-01-01T00:00:00Z'),
      lastModifiedBy: null
    }

    expect(agentRecordToSpec(base, { API_KEY: 'sk-1' })).toMatchObject({ secrets: { API_KEY: 'sk-1' } })
    expect(agentRecordToSpec(base, {})).toMatchObject({ secrets: {} })
  })
})
