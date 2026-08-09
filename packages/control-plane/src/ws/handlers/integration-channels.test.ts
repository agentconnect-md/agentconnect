/**
 * `integration/channels` — the §4.2(4) `isPrivate` cross-check seam
 * (session-access-cold-visit.md): a snapshot that marks a channel private drops
 * any cached `public` Slack audience verdict for the integration's bot. Tested
 * at the handler because the seam is the handler's: which channels it names,
 * which bot it resolves, and when it stays silent.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, type IntegrationChannel } from '@agentconnect.md/protocol'
import { handleIntegrationChannels } from './integration-channels.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'

const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const INTEGRATION = '11111111-1111-4111-8111-111111111111'
const BOT = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const conn = { daemonId: DAEMON } as unknown as DaemonConnection

function fakeDeps(platform = 'slack', known = true) {
  const dropPublicAudiences = vi.fn()
  const integration = known ? [{ id: INTEGRATION, agentId: AGENT, botId: BOT, orgId: 'org-1', platform }] : []
  const deps = {
    integration: { activeForDaemon: vi.fn(async () => integration) },
    slackSessionAccess: { dropPublicAudiences },
    agentMutations: { tryBeginMutation: vi.fn(() => vi.fn()) },
    agent: { getUnscoped: vi.fn(async () => null) },
    integrationChannel: { replaceSnapshot: vi.fn(async () => {}) },
    collabRoutes: { broadcast: vi.fn(async () => {}) }
  } as unknown as DaemonWsDeps
  return { deps, dropPublicAudiences }
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
})
