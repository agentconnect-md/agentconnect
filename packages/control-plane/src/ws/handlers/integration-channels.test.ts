/**
 * `integration/channels` — the §4.2(4) `isPrivate` cross-check seam
 * (session-access-cold-visit.md): a snapshot that marks a channel private drops
 * any cached `public` Slack audience verdict for the integration's bot. Tested
 * at the handler because the seam is the handler's: which channels it names,
 * which bot it resolves, and when it stays silent.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, SESSION_MODE_AUTO_V1_FEATURE, type IntegrationChannel } from '@agentconnect.md/protocol'
import { handleIntegrationChannels } from './integration-channels.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const INTEGRATION = '11111111-1111-4111-8111-111111111111'
const BOT = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const conn = { daemonId: DAEMON } as unknown as DaemonConnection

function fakeDeps(
  platform = 'slack',
  known = true,
  externalChanged = false,
  reporter: { features?: string[]; autoCreated?: boolean } = {}
) {
  const dropPublicAudiences = vi.fn()
  const integrationConverge = vi.fn(async () => {})
  const integration = known ? [{ id: INTEGRATION, agentId: AGENT, botId: BOT, orgId: 'org-1', platform }] : []
  const deps = {
    // The handler admits by SERVED agents now, so the repo read is the agent-keyed one.
    integration: { activeForAgents: vi.fn(async () => integration) },
    slackSessionAccess: { dropPublicAudiences },
    agentMutations: { tryBeginMutation: vi.fn(() => vi.fn()) },
    agent: {
      get: vi.fn(async () => ({ id: AGENT, visibility: 'org' })),
      listForDaemon: vi.fn(async () => [{ id: AGENT }]),
      listByIds: vi.fn(async () => [])
    },
    clock: { now: () => Date.now() },
    integrationChannel: {
      replaceSnapshot: vi.fn(async () => ({ externalChanged, ...(reporter.autoCreated ? { autoCreated: true } : {}) }))
    },
    integrationConverge,
    collabRoutes: { broadcast: vi.fn(async () => {}) },
    connReg: {
      get: () => (reporter.features ? { state: 'READY', capabilities: { features: reporter.features } } : undefined)
    }
  } as unknown as DaemonWsDeps
  return {
    deps,
    dropPublicAudiences,
    integrationConverge,
    replaceSnapshot: deps.integrationChannel.replaceSnapshot as ReturnType<typeof vi.fn>
  }
}

function frame(channels: IntegrationChannel[]) {
  return buildEnvelope('integration/channels', { integrationId: INTEGRATION, channels })
}

describe('handleIntegrationChannels — isPrivate cross-check', () => {
  it('drops the public audience verdicts of exactly the channels observed private', async () => {
    const { deps, dropPublicAudiences } = fakeDeps()
    await handleIntegrationChannels(
      frame([{ id: 'C_PRIVATE', isPrivate: true }, { id: 'C_PUBLIC', isPrivate: false }, { id: 'C_UNSTATED' }]),
      conn,
      deps
    )
    expect(dropPublicAudiences).toHaveBeenCalledTimes(1)
    expect(dropPublicAudiences).toHaveBeenCalledWith(BOT, ['C_PRIVATE'])
  })

  it('stays silent when no channel is observed private', async () => {
    const { deps, dropPublicAudiences } = fakeDeps()
    await handleIntegrationChannels(frame([{ id: 'C_PUBLIC', isPrivate: false }, { id: 'C_UNSTATED' }]), conn, deps)
    expect(dropPublicAudiences).not.toHaveBeenCalled()
  })

  it('stays silent for a non-Slack integration', async () => {
    const { deps, dropPublicAudiences } = fakeDeps('discord')
    await handleIntegrationChannels(frame([{ id: 'C_PRIVATE', isPrivate: true }]), conn, deps)
    expect(dropPublicAudiences).not.toHaveBeenCalled()
  })

  it('stays silent for an integration this daemon does not own', async () => {
    const { deps, dropPublicAudiences } = fakeDeps('slack', false)
    await handleIntegrationChannels(frame([{ id: 'C_PRIVATE', isPrivate: true }]), conn, deps)
    expect(dropPublicAudiences).not.toHaveBeenCalled()
  })

  it('hands the row’s own handle and link to the write, so a team row reaches the console linked', async () => {
    const { deps, replaceSnapshot } = fakeDeps('linear')
    await handleIntegrationChannels(
      frame([
        {
          id: 'team-1',
          name: 'Acme / Engineering',
          key: 'ENG',
          url: 'https://linear.app/example-workspace/team/ENG'
        },
        { id: 'team-2', name: 'Acme / Design' }
      ]),
      conn,
      deps
    )
    expect(replaceSnapshot.mock.calls[0]![1]).toEqual([
      { id: 'team-1', name: 'Acme / Engineering', key: 'ENG', url: 'https://linear.app/example-workspace/team/ENG' },
      { id: 'team-2', name: 'Acme / Design' }
    ])
  })

  it('hands the row’s own glyph to the write, so a Linear team reaches the console drawn', async () => {
    const { deps, replaceSnapshot } = fakeDeps('linear')
    await handleIntegrationChannels(
      frame([
        { id: 'team-1', name: 'Acme / Engineering', icon: 'Feather', color: '#5E6AD2' },
        { id: 'team-2', name: 'Acme / Design' }
      ]),
      conn,
      deps
    )
    expect(replaceSnapshot).toHaveBeenCalledTimes(1)
    expect(replaceSnapshot.mock.calls[0]![1]).toEqual([
      { id: 'team-1', name: 'Acme / Engineering', icon: 'Feather', color: '#5E6AD2' },
      { id: 'team-2', name: 'Acme / Design' }
    ])
  })
})

// assistant-mode.md §5.3: the detected external set rides the spec, so a report that changed it re-pushes it.
describe('handleIntegrationChannels — detected external places', () => {
  const shared = { id: 'C1', externalReason: 'externallyShared' as const }

  it('hands the detection to the write and re-pushes the spec when the set changed', async () => {
    const { deps, replaceSnapshot, integrationConverge } = fakeDeps('slack', true, true)
    await handleIntegrationChannels(frame([shared]), conn, deps)
    expect(replaceSnapshot.mock.calls[0]![1]).toEqual([shared])
    expect(integrationConverge).toHaveBeenCalledTimes(1)
  })

  it('does not re-push when the report changed nothing', async () => {
    const { deps, integrationConverge } = fakeDeps('slack', true, false)
    await handleIntegrationChannels(frame([shared]), conn, deps)
    expect(integrationConverge).not.toHaveBeenCalled()
  })
})

// auto-session-mode.md §3.2: a new room or group DM starts on Auto where the reporting daemon reads it, and reaches it at once.
describe('handleIntegrationChannels — new conversations on Auto', () => {
  it('starts new rooms and group DMs on Auto for a daemon that reads it, and pushes the spec it lacks', async () => {
    const { deps, replaceSnapshot, integrationConverge } = fakeDeps('slack', true, false, {
      features: [SESSION_MODE_AUTO_V1_FEATURE],
      autoCreated: true
    })
    await handleIntegrationChannels(frame([{ id: 'C1' }]), conn, deps)
    expect(replaceSnapshot.mock.calls[0]![2]).toEqual({ autoKinds: ['channel', 'mpim'] })
    expect(integrationConverge).toHaveBeenCalledTimes(1)
  })

  it('keeps every new row Per thread for a daemon that does not read it, and pushes nothing', async () => {
    const { deps, replaceSnapshot, integrationConverge } = fakeDeps('slack', true, false, { features: [] })
    await handleIntegrationChannels(frame([{ id: 'C1' }]), conn, deps)
    expect(replaceSnapshot.mock.calls[0]![2]).toBeUndefined()
    expect(integrationConverge).not.toHaveBeenCalled()
  })

  it('never starts a row on Auto where its platform keys no conversation session', async () => {
    const { deps, replaceSnapshot } = fakeDeps('linear', true, false, { features: [SESSION_MODE_AUTO_V1_FEATURE] })
    await handleIntegrationChannels(frame([{ id: 'team-1' }]), conn, deps)
    expect(replaceSnapshot.mock.calls[0]![2]).toBeUndefined()
  })
})
