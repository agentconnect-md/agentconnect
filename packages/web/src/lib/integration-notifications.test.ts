import { describe, expect, it } from 'vitest'
import { botCardCopy } from '@/components/console/platforms/registry'
import type { IntegrationRow } from '@/lib/data'
import { revokedIntegrationNotifications, revokedIntegrationSourceKey } from '@/lib/integration-notifications'
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

describe('revokedIntegrationNotifications', () => {
  it('projects each revoked integration into one error item keyed by its id, linking to its agent', () => {
    const items = revokedIntegrationNotifications(
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
      revokedIntegrationNotifications(
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
      revokedIntegrationNotifications([row()], agents, orgPath),
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
        revokedIntegrationNotifications(rows, roster, orgPath),
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
})
