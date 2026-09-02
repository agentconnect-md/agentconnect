import { describe, expect, it } from 'vitest'
import { approvalNotifications, approvalSourceKey } from '@/lib/approval-notifications'

const orgPath = (path: string) => `/acme${path}`
const agents = [
  { id: 'agent-a', name: 'Butler', canEdit: true },
  { id: 'agent-b', name: 'Viewer-only', canEdit: false }
]

describe('approvalNotifications (slack-approval-dm.md §7)', () => {
  it('projects an editable agent’s waiting session into one unread, deep-linked item', () => {
    const [item, ...rest] = approvalNotifications(
      [{ sessionId: 's/1', agentId: 'agent-a', agentName: 'Butler', title: 'Roll out api@1.4.2' }],
      agents,
      orgPath
    )
    expect(rest).toEqual([])
    expect(item).toMatchObject({
      category: 'approval',
      severity: 'warning',
      sourceKey: approvalSourceKey('s/1'),
      title: 'Approval needed',
      message: 'Butler is waiting for permission in “Roll out api@1.4.2”.',
      action: { label: 'Open session', href: '/acme/sessions/s%2F1', external: false },
      resolution: { title: 'Approval resolved', read: true }
    })
  })

  it('drops sessions of agents the viewer cannot edit, and unknown agents', () => {
    expect(
      approvalNotifications(
        [
          { sessionId: 's1', agentId: 'agent-b', agentName: null, title: null },
          { sessionId: 's2', agentId: 'agent-gone', agentName: 'Ghost', title: null }
        ],
        agents,
        orgPath
      )
    ).toEqual([])
  })

  it('falls back to the roster name and omits the title clause when the row has neither', () => {
    const [item] = approvalNotifications(
      [{ sessionId: 's1', agentId: 'agent-a', agentName: '  ', title: '' }],
      agents,
      orgPath
    )
    expect(item?.message).toBe('Butler is waiting for permission.')
    expect(item?.resolution?.message).toBe('Butler is no longer waiting for permission.')
  })
})
