import { describe, expect, it, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import type { SessionMetaRecord, SessionMilestoneResult } from '../../persistence/ports.js'
import { SessionId } from '../../domain/ids.js'
import { handleEventSession, handleEventSessionSync } from './event-session.js'

const DAEMON_ID = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT_ID = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORG_ID = 'org-1'
const SESSION_ID = 'session-407'
const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111'
const BOT_ID = '22222222-2222-4222-8222-222222222222'
const HOOK_ID = '33333333-3333-4333-8333-333333333333'
const GITHUB_INSTALLATION_ROW_ID = '44444444-4444-4444-8444-444444444444'

function scopedDeps(extra: Record<string, unknown>): DaemonWsDeps {
  return {
    log: { error: vi.fn() },
    agent: { get: vi.fn().mockResolvedValue({ daemonId: DAEMON_ID }) },
    agentMutations: { tryBeginMutation: vi.fn(() => vi.fn()) },
    hook: { get: vi.fn().mockResolvedValue(null) },
    ...extra
  } as unknown as DaemonWsDeps
}

function eventSessionFrame(type: 'event/session' | 'event/session-sync' = 'event/session'): AnyFrame {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: '2026-07-10T00:00:00.000Z',
    type,
    payload: {
      sessionId: 'session-407',
      agentId: AGENT_ID,
      phase: 'start',
      platform: 'slack',
      channel: 'C407',
      title: 'Fresh session',
      ts: '2026-07-10T00:00:00.000Z'
    }
  }
}

/** A minimal `recorded` result: the upsert landed and settled no A2A children. */
function recorded(session: Partial<SessionMetaRecord> = {}): SessionMilestoneResult {
  return {
    recorded: true,
    session: { id: SESSION_ID, agentId: AGENT_ID, parentSessionId: null, ...session } as SessionMetaRecord,
    settled: []
  }
}

describe('handleEventSession', () => {
  it('ACKs a durable snapshot only after its metadata transaction commits', async () => {
    const order: string[] = []
    let finishPersist!: () => void
    const recordMilestone = vi.fn(() => {
      order.push('persist:start')
      return new Promise<SessionMilestoneResult>((resolve) => {
        finishPersist = () => {
          order.push('persist:finish')
          resolve(recorded())
        }
      })
    })
    const replyTo = vi.fn(() => order.push('ack'))
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn(() => order.push('publish')) }
    })
    const frame = eventSessionFrame('event/session-sync')
    const conn = {
      daemonId: DAEMON_ID,
      orgId: ORG_ID,
      replyTo,
      sendError: vi.fn()
    } as unknown as DaemonConnection

    const handling = handleEventSessionSync(frame, conn, deps)
    await vi.waitFor(() => expect(order).toEqual(['persist:start']))
    expect(replyTo).not.toHaveBeenCalled()

    finishPersist()
    await handling

    expect(order).toEqual(['persist:start', 'persist:finish', 'publish', 'ack'])
    expect(replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
  })

  it('keeps a durable snapshot retryable when persistence fails', async () => {
    const frame = eventSessionFrame('event/session-sync')
    const replyTo = vi.fn()
    const sendError = vi.fn()
    const error = vi.fn()
    const failure = new Error('db unavailable')
    const deps = scopedDeps({
      log: { error },
      session: { recordMilestone: vi.fn().mockRejectedValue(failure) },
      events: { publish: vi.fn() }
    })

    await handleEventSessionSync(
      frame,
      { daemonId: DAEMON_ID, orgId: ORG_ID, replyTo, sendError } as unknown as DaemonConnection,
      deps
    )

    expect(replyTo).not.toHaveBeenCalled()
    expect(sendError).toHaveBeenCalledWith(frame.id, 'INTERNAL', expect.any(String), true)
    expect(error).toHaveBeenCalledWith(
      { err: failure, daemonId: DAEMON_ID, agentId: AGENT_ID, sessionId: SESSION_ID },
      'event/session-sync: metadata snapshot persistence failed'
    )
  })

  it('publishes the milestone only after it has been persisted', async () => {
    const order: string[] = []
    let finishPersist!: () => void
    const recordMilestone = vi.fn(() => {
      order.push('persist:start')
      return new Promise<SessionMilestoneResult>((resolve) => {
        finishPersist = () => {
          order.push('persist:finish')
          resolve(recorded())
        }
      })
    })
    const publish = vi.fn(() => {
      order.push('publish')
    })
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish }
    })
    const conn = { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection
    const frame = eventSessionFrame()

    const handling = handleEventSession(frame, conn, deps)

    await vi.waitFor(() => expect(order).toEqual(['persist:start']))
    expect(order).toEqual(['persist:start'])
    expect(publish).not.toHaveBeenCalled()

    finishPersist()
    await handling

    expect(order).toEqual(['persist:start', 'persist:finish', 'publish'])
    expect(publish).toHaveBeenCalledWith(DAEMON_ID, frame.payload)
  })

  it('passes the execution-config snapshot through and stamps daemonId from the connection', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      runtime: 'claude',
      model: 'opus',
      observedModel: null,
      effort: 'high',
      fastMode: true,
      permissionMode: 'acceptEdits',
      outputMode: 'medium'
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'claude',
        // A runtime observation wins over the legacy/config snapshot; null is
        // preserved so persistence can clear a previously named model.
        model: null,
        effort: 'high',
        fastMode: true,
        permissionMode: 'acceptEdits',
        outputMode: 'medium',
        // The reporting daemon is CP-stamped from the authenticated connection,
        // never taken from the frame payload.
        daemonId: DAEMON_ID
      })
    )
  })

  it('inherits an A2A webchat child without treating its synthetic channel as a conversation UUID', async () => {
    const recordMilestone = vi
      .fn()
      .mockResolvedValue(
        recorded({ parentSessionId: SessionId('parent-session'), visibilitySource: 'inherited_pending' })
      )
    const findOwner = vi.fn().mockRejectedValue(new Error('must not query a synthetic A2A channel'))
    const deps = scopedDeps({
      session: { recordMilestone },
      webchatConversation: { findOwner },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'webchat',
      channel: `a2a:${AGENT_ID}`,
      parentSessionId: 'parent-session'
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(findOwner).not.toHaveBeenCalled()
    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-session',
        platform: 'webchat',
        channel: `a2a:${AGENT_ID}`,
        classification: { inherit: true }
      })
    )
  })

  it('binds a Slack audience only after validating its integration and workspace', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      integration: {
        get: vi.fn().mockResolvedValue({
          id: INTEGRATION_ID,
          agentId: AGENT_ID,
          botId: BOT_ID,
          orgId: 'org-1',
          platform: 'slack',
          status: 'active'
        })
      },
      bot: {
        get: vi.fn().mockResolvedValue({
          id: BOT_ID,
          orgId: 'org-1',
          platform: 'slack',
          workspaceId: 'T407',
          teamId: null,
          revokedAt: null
        })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      externalOrigin: {
        provider: 'slack',
        realmKey: 'T407',
        resourceKind: 'conversation',
        resourceKey: 'C407',
        integrationId: INTEGRATION_ID
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        externalCandidate: {
          provider: 'slack',
          resolution: 'settled',
          scope: {
            realmKey: 'T407',
            resourceKind: 'conversation',
            resourceKey: 'C407',
            credentialKind: 'bot',
            credentialId: BOT_ID
          }
        }
      })
    )
  })

  it('binds a Feishu/Lark audience to the registered Bot app', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      integration: {
        get: vi.fn().mockResolvedValue({
          id: INTEGRATION_ID,
          agentId: AGENT_ID,
          botId: BOT_ID,
          orgId: 'org-1',
          platform: 'feishu',
          status: 'active'
        })
      },
      bot: {
        get: vi.fn().mockResolvedValue({
          id: BOT_ID,
          orgId: 'org-1',
          platform: 'feishu',
          feishuRegion: 'lark',
          feishuAppId: 'cli_platform',
          revokedAt: null
        })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'feishu',
      channel: 'oc_chat',
      externalOrigin: {
        provider: 'feishu',
        realmKey: 'lark:cli_platform',
        resourceKind: 'conversation',
        resourceKey: 'oc_chat',
        integrationId: INTEGRATION_ID
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        externalCandidate: {
          provider: 'feishu',
          resolution: 'settled',
          scope: {
            realmKey: 'lark:cli_platform',
            resourceKind: 'conversation',
            resourceKey: 'oc_chat',
            credentialKind: 'bot',
            credentialId: BOT_ID
          }
        }
      })
    )
  })

  it('binds a user-built Feishu/Lark app without matching the login App ID', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      integration: {
        get: vi.fn().mockResolvedValue({
          id: INTEGRATION_ID,
          agentId: AGENT_ID,
          botId: BOT_ID,
          orgId: 'org-1',
          platform: 'feishu',
          status: 'active'
        })
      },
      bot: {
        get: vi.fn().mockResolvedValue({
          id: BOT_ID,
          orgId: 'org-1',
          platform: 'feishu',
          feishuRegion: 'lark',
          feishuAppId: 'cli_custom',
          revokedAt: null
        })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'feishu',
      channel: 'oc_chat',
      externalOrigin: {
        provider: 'feishu',
        realmKey: 'lark:cli_custom',
        resourceKind: 'conversation',
        resourceKey: 'oc_chat',
        integrationId: INTEGRATION_ID
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        externalCandidate: {
          provider: 'feishu',
          resolution: 'settled',
          scope: {
            realmKey: 'lark:cli_custom',
            resourceKind: 'conversation',
            resourceKey: 'oc_chat',
            credentialKind: 'bot',
            credentialId: BOT_ID
          }
        }
      })
    )
  })

  it('keeps a root shared Slack session from an older daemon as an unresolved candidate', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn() }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ externalCandidate: { provider: 'slack', resolution: 'pending' } })
    )
  })

  it('does not treat an explicitly local platform-shaped session as a Slack candidate', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(
      recorded({
        visibility: 'org',
        externalProvider: null,
        visibilityRev: 1,
        visibilityAckedRev: 0
      })
    )
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, { sourceBindingKind: 'local' })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    const milestone = recordMilestone.mock.calls[0]![0]
    expect(milestone).not.toHaveProperty('externalCandidate')
  })

  it('marks a forged Slack workspace binding invalid', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      integration: {
        get: vi.fn().mockResolvedValue({
          id: INTEGRATION_ID,
          agentId: AGENT_ID,
          botId: BOT_ID,
          orgId: 'org-1',
          platform: 'slack',
          status: 'active'
        })
      },
      bot: {
        get: vi.fn().mockResolvedValue({
          id: BOT_ID,
          orgId: 'org-1',
          platform: 'slack',
          workspaceId: 'T407',
          teamId: null,
          revokedAt: null
        })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      externalOrigin: {
        provider: 'slack',
        realmKey: 'T-FORGED',
        resourceKind: 'conversation',
        resourceKey: 'C407',
        integrationId: INTEGRATION_ID
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ externalCandidate: { provider: 'slack', resolution: 'invalid' } })
    )
  })

  it('binds a GitHub audience only to the accepted delivery snapshot and installation claim', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      hook: {
        getRun: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          agentId: AGENT_ID,
          repoId: 123n,
          repoFullName: 'acme/repo',
          sourceInstallationId: 456n
        })
      },
      githubInstallation: {
        getByInstallationId: vi.fn().mockResolvedValue({
          id: GITHUB_INSTALLATION_ROW_ID,
          orgId: 'org-1'
        })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      externalOrigin: {
        provider: 'github',
        realmKey: 'github.com',
        resourceKind: 'repository',
        resourceKey: '123',
        hookId: HOOK_ID,
        deliveryKey: 'delivery-1',
        sourceInstallationId: '456',
        repoFullName: 'acme/repo'
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        externalCandidate: {
          provider: 'github',
          resolution: 'settled',
          scope: {
            realmKey: 'github.com',
            resourceKind: 'repository',
            resourceKey: '123',
            credentialKind: 'github_installation',
            credentialId: GITHUB_INSTALLATION_ROW_ID
          }
        }
      })
    )
  })

  it('rejects a GitHub audience that differs from the accepted delivery snapshot', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const getByInstallationId = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone },
      hook: {
        getRun: vi.fn().mockResolvedValue({
          orgId: 'org-1',
          agentId: AGENT_ID,
          repoId: 999n,
          repoFullName: 'acme/repo',
          sourceInstallationId: 456n
        })
      },
      githubInstallation: { getByInstallationId },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      externalOrigin: {
        provider: 'github',
        realmKey: 'github.com',
        resourceKind: 'repository',
        resourceKey: '123',
        hookId: HOOK_ID,
        deliveryKey: 'delivery-1',
        sourceInstallationId: '456',
        repoFullName: 'acme/repo'
      }
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ externalCandidate: { provider: 'github', resolution: 'invalid' } })
    )
    expect(getByInstallationId).not.toHaveBeenCalled()
  })

  it('keeps a GitHub hook session from an older daemon unresolved', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const deps = scopedDeps({
      session: { recordMilestone },
      hook: {
        get: vi.fn().mockResolvedValue({ kind: 'github', agentId: AGENT_ID })
      },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'hook',
      channel: HOOK_ID,
      triggeredBy: `hook:${HOOK_ID}`
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({ externalCandidate: { provider: 'github', resolution: 'pending' } })
    )
  })

  it('inherits a hook A2A child audience without querying its synthetic channel as a hook id', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded({ parentSessionId: SessionId('parent-session') }))
    const get = vi.fn().mockRejectedValue(new Error('synthetic channel reached HookRepo'))
    const replyTo = vi.fn()
    const sendError = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone },
      hook: { get },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame('event/session-sync')
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'hook',
      channel: `a2a:${AGENT_ID}`,
      parentSessionId: 'parent-session',
      triggeredBy: undefined
    })

    await handleEventSessionSync(
      frame,
      { daemonId: DAEMON_ID, orgId: ORG_ID, replyTo, sendError } as unknown as DaemonConnection,
      deps
    )

    expect(get).not.toHaveBeenCalled()
    expect(recordMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: 'parent-session',
        classification: expect.objectContaining({ inherit: true })
      })
    )
    expect(recordMilestone.mock.calls[0]![0].externalCandidate).toBeUndefined()
    expect(replyTo).toHaveBeenCalledWith(frame, 'ack', { ok: true })
    expect(sendError).not.toHaveBeenCalled()
  })

  it('treats a non-UUID legacy hook coordinate as a miss', async () => {
    const recordMilestone = vi.fn().mockResolvedValue(recorded())
    const get = vi.fn().mockRejectedValue(new Error('invalid hook id reached Prisma'))
    const deps = scopedDeps({
      session: { recordMilestone },
      hook: { get },
      events: { publish: vi.fn() }
    })
    const frame = eventSessionFrame()
    Object.assign(frame.payload as Record<string, unknown>, {
      platform: 'hook',
      channel: `a2a:${AGENT_ID}`,
      triggeredBy: undefined
    })

    await handleEventSession(frame, { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(get).not.toHaveBeenCalled()
    expect(recordMilestone.mock.calls[0]![0].externalCandidate).toBeUndefined()
  })

  it('pokes the session-access warmer only after the commit-then-publish point', async () => {
    const order: string[] = []
    const poke = vi.fn(() => {
      order.push('poke')
    })
    const recordMilestone = vi.fn().mockResolvedValue(
      recorded({
        orgId: 'org-1' as SessionMetaRecord['orgId'],
        visibility: 'external',
        externalScopeId: 'scope-1'
      })
    )
    const deps = scopedDeps({
      session: { recordMilestone },
      events: { publish: vi.fn(() => order.push('publish')) },
      sessionAccessWarmer: { poke }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(order).toEqual(['publish', 'poke'])
    expect(poke).toHaveBeenCalledWith('org-1', 'scope-1')
  })

  it('does not poke the warmer for a non-external milestone', async () => {
    const poke = vi.fn()
    const deps = scopedDeps({
      session: {
        recordMilestone: vi.fn().mockResolvedValue(recorded({ visibility: 'org', externalScopeId: null }))
      },
      events: { publish: vi.fn() },
      sessionAccessWarmer: { poke }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(poke).not.toHaveBeenCalled()
  })

  // §4.2(6): a CP restart drains daemon outboxes as `event/session-sync` — one
  // frame per active session, against cold cooldown state. Replays never poke.
  it('never pokes the warmer from a replayed event/session-sync snapshot', async () => {
    const poke = vi.fn()
    const deps = scopedDeps({
      session: {
        recordMilestone: vi.fn().mockResolvedValue(
          recorded({
            orgId: 'org-1' as SessionMetaRecord['orgId'],
            visibility: 'external',
            externalScopeId: 'scope-1'
          })
        )
      },
      events: { publish: vi.fn() },
      sessionAccessWarmer: { poke }
    })

    await handleEventSessionSync(
      eventSessionFrame('event/session-sync'),
      { daemonId: DAEMON_ID, orgId: ORG_ID, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection,
      deps
    )

    expect(poke).not.toHaveBeenCalled()
  })

  it('captures PR ownership only from the exact session lifecycle snapshot', async () => {
    const trackSession = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone: vi.fn().mockResolvedValue(recorded({ phase: 'end' })) },
      events: { publish: vi.fn() },
      pullRequestFeedback: { trackSession }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)
    expect(trackSession).toHaveBeenCalledOnce()

    trackSession.mockClear()
    await handleEventSessionSync(
      eventSessionFrame('event/session-sync'),
      { daemonId: DAEMON_ID, orgId: ORG_ID, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection,
      deps
    )
    expect(trackSession).toHaveBeenCalledOnce()
  })

  it('does not publish when persistence fails', async () => {
    const failure = new Error('write failed')
    const publish = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone: vi.fn().mockRejectedValue(failure) },
      events: { publish }
    })

    await expect(
      handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)
    ).rejects.toBe(failure)
    expect(publish).not.toHaveBeenCalled()
  })

  it('does not publish a milestone rejected by the session ownership fence', async () => {
    const publish = vi.fn()
    const deps = scopedDeps({
      session: { recordMilestone: vi.fn().mockResolvedValue({ recorded: false, session: null, settled: [] }) },
      events: { publish }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(publish).not.toHaveBeenCalled()
  })

  it('drops a milestone for an agent not placed on the reporting daemon', async () => {
    const release = vi.fn()
    const recordMilestone = vi.fn()
    const publish = vi.fn()
    const deps = scopedDeps({
      agent: { get: vi.fn().mockResolvedValue({ daemonId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }) },
      agentMutations: { tryBeginMutation: vi.fn(() => release) },
      session: { recordMilestone },
      events: { publish }
    })

    await handleEventSession(eventSessionFrame(), { daemonId: DAEMON_ID, orgId: ORG_ID } as DaemonConnection, deps)

    expect(recordMilestone).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
})
