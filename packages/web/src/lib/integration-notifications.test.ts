import { describe, expect, it } from 'vitest'
import { botCardCopy } from '@/components/console/platforms/registry'
import type { IntegrationRow } from '@/lib/data'
import {
  integrationCredentialNotifications,
  rejectedIntegrationSourceKey,
  revokedIntegrationSourceKey
} from '@/lib/integration-notifications'
import { emptyNotificationState, syncNotificationSourceSnapshot } from '@/lib/notifications'

const orgPath = (path: string) => `/acme${path}`
const agents = [
  { id: 'agent/a', name: 'Butler', canEdit: true },
  { id: 'agent-b', name: 'Scout', canEdit: true },
  { id: 'agent-c', name: 'Viewer-only', canEdit: false }
]

function row(over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'int-1',
    agentId: 'agent/a',
    botId: 'bot-1',
    name: 'acme-bot',
    platform: 'slack',
    kind: 'Custom app',
    workspace: '—',
    daemon: 'edge-1',
    status: 'offline',
    revoked: true,
    channels: [],
    ...over
  }
}

describe('integrationCredentialNotifications', () => {
  it('projects each revoked integration into one error item keyed by its id, linking to its agent', () => {
    const items = integrationCredentialNotifications(
      [
        row(),
        row({ id: 'int-2', agentId: 'agent-b', name: 'ops', platform: 'telegram' }),
        row({ id: 'int-3', revoked: false, status: 'online' })
      ],
      agents,
      orgPath
    )
    expect(items.map((item) => item.sourceKey)).toEqual([
      revokedIntegrationSourceKey('int-1'),
      revokedIntegrationSourceKey('int-2')
    ])
    expect(items[0]).toMatchObject({
      category: 'integration',
      severity: 'error',
      title: 'Integration revoked',
      message: `Butler can no longer use “acme-bot”. ${botCardCopy('slack').revokedHint}.`,
      action: { label: 'Open agent', href: '/acme/agents/agent%2Fa', external: false },
      resolution: {
        title: 'Revocation resolved',
        message: 'Butler’s “acme-bot” no longer needs your attention.',
        read: true
      }
    })
    expect(items[1]?.message).toBe(`Scout can no longer use “ops”. ${botCardCopy('telegram').revokedHint}.`)
  })

  it('drops integrations of agents the viewer cannot edit, unknown agents, and rows without ids', () => {
    expect(
      integrationCredentialNotifications(
        [
          row({ agentId: 'agent-c' }),
          row({ agentId: 'agent-gone' }),
          row({ id: undefined }),
          row({ agentId: undefined })
        ],
        agents,
        orgPath
      )
    ).toEqual([])
  })

  it('resolves the item, read, once the integration is reconnected or removed, or the viewer loses edit rights', () => {
    const revoked = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'integrations',
      integrationCredentialNotifications([row()], agents, orgPath),
      '2026-09-23T01:00:00.000Z',
      () => 'revoked-1'
    )
    expect(revoked.added).toHaveLength(1)
    expect(revoked.state.activeSources.integrations).toEqual([revokedIntegrationSourceKey('int-1')])

    const readOnly = agents.map((agent) => ({ ...agent, canEdit: false }))
    for (const [rows, roster] of [
      [[row({ revoked: false, status: 'online' })], agents],
      [[], agents],
      [[row()], readOnly]
    ] as const) {
      const cleared = syncNotificationSourceSnapshot(
        revoked.state,
        'integrations',
        integrationCredentialNotifications(rows, roster, orgPath),
        '2026-09-23T02:00:00.000Z'
      )
      expect(cleared.state.notifications[0]).toMatchObject({
        id: 'revoked-1',
        severity: 'info',
        title: 'Revocation resolved',
        read: true,
        resolvedAt: '2026-09-23T02:00:00.000Z'
      })
      expect(cleared.state.notifications[0]?.action).toBeUndefined()
    }
  })

  it('appends the code a revocation recorded to its sentence', () => {
    const [item] = integrationCredentialNotifications([row({ credentialCode: 'token_revoked' })], agents, orgPath)
    expect(item?.message).toBe(
      `Butler can no longer use “acme-bot”. ${botCardCopy('slack').revokedHint} (token_revoked).`
    )
  })
})

// An ambiguous rejection leaves the integration active, but the viewer still has something to fix.
describe('integrationCredentialNotifications for a rejected credential', () => {
  const rejected = (over: Partial<IntegrationRow> = {}) =>
    row({ revoked: false, status: 'online', rejected: true, credentialCode: 'invalid_auth', ...over })

  it('projects a rejected integration into its own error item, with the module’s sentence and the code', () => {
    const items = integrationCredentialNotifications(
      [rejected(), rejected({ id: 'int-2', agentId: 'agent-c' })],
      agents,
      orgPath
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      category: 'integration',
      severity: 'error',
      sourceKey: rejectedIntegrationSourceKey('int-1'),
      title: 'Integration credentials rejected',
      message: `Butler’s “acme-bot” credentials were rejected. ${botCardCopy('slack').rejectedHint} (invalid_auth).`,
      action: { label: 'Open agent', href: '/acme/agents/agent%2Fa', external: false },
      resolution: {
        title: 'Rejection resolved',
        message: 'Butler’s “acme-bot” no longer needs your attention.',
        severity: 'info',
        read: true
      }
    })
    expect(rejectedIntegrationSourceKey('int-1')).not.toBe(revokedIntegrationSourceKey('int-1'))
  })

  it('produces only the revoked item for a revoked integration that also carries a rejected mark', () => {
    const items = integrationCredentialNotifications(
      [row({ rejected: true, credentialCode: 'token_revoked' })],
      agents,
      orgPath
    )
    expect(items.map((item) => item.sourceKey)).toEqual([revokedIntegrationSourceKey('int-1')])
    expect(items[0]?.title).toBe('Integration revoked')
  })

  it('resolves the item, read, once the mark clears', () => {
    const open = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'integrations',
      integrationCredentialNotifications([rejected()], agents, orgPath),
      '2026-09-23T01:00:00.000Z',
      () => 'rejected-1'
    )
    expect(open.state.activeSources.integrations).toEqual([rejectedIntegrationSourceKey('int-1')])

    const cleared = syncNotificationSourceSnapshot(
      open.state,
      'integrations',
      integrationCredentialNotifications([rejected({ rejected: false, credentialCode: null })], agents, orgPath),
      '2026-09-23T02:00:00.000Z'
    )
    expect(cleared.added).toEqual([])
    expect(cleared.state.notifications).toHaveLength(1)
    expect(cleared.state.notifications[0]).toMatchObject({
      id: 'rejected-1',
      severity: 'info',
      title: 'Rejection resolved',
      read: true,
      resolvedAt: '2026-09-23T02:00:00.000Z'
    })
    expect(cleared.state.notifications[0]?.action).toBeUndefined()
  })

  it('swaps the rejected item for a revoked one when the credential is then revoked', () => {
    const open = syncNotificationSourceSnapshot(
      emptyNotificationState(),
      'integrations',
      integrationCredentialNotifications([rejected()], agents, orgPath),
      '2026-09-23T01:00:00.000Z',
      () => 'rejected-1'
    )

    const swapped = syncNotificationSourceSnapshot(
      open.state,
      'integrations',
      integrationCredentialNotifications([row({ rejected: true, credentialCode: 'token_revoked' })], agents, orgPath),
      '2026-09-23T02:00:00.000Z',
      () => 'revoked-1'
    )
    expect(swapped.added.map((item) => item.id)).toEqual(['revoked-1'])
    expect(swapped.state.activeSources.integrations).toEqual([revokedIntegrationSourceKey('int-1')])
    const byId = new Map(swapped.state.notifications.map((item) => [item.id, item]))
    expect(byId.get('rejected-1')).toMatchObject({
      title: 'Rejection resolved',
      resolvedAt: '2026-09-23T02:00:00.000Z'
    })
    expect(byId.get('revoked-1')).toMatchObject({ title: 'Integration revoked', severity: 'error' })
    expect(byId.get('revoked-1')?.resolvedAt).toBeUndefined()
  })
})
