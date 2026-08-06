import { describe, expect, it, vi } from 'vitest'
import { syncSessionAccessNotificationSnapshots } from '@/lib/session-access-notifier'

const orgPath = (path: string) => `/acme${path}`

describe('syncSessionAccessNotificationSnapshots', () => {
  it('synchronizes ready Session and Usage snapshots into distinct scopes', () => {
    const sync = vi.fn()
    syncSessionAccessNotificationSnapshots(
      {
        sessionAccessSnapshot: {
          degraded: true,
          issues: [{ provider: 'feishu', region: 'lark', reason: 'quota' }]
        },
        usageAccessSnapshot: {
          degraded: true,
          issues: [{ provider: 'feishu', region: 'feishu', reason: 'authorization' }]
        },
        orgPath
      },
      sync
    )

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenNthCalledWith(
      1,
      'sessions-access',
      expect.arrayContaining([expect.objectContaining({ sourceKey: 'sessions:feishu:lark:quota' })])
    )
    expect(sync).toHaveBeenNthCalledWith(
      2,
      'usage-access',
      expect.arrayContaining([expect.objectContaining({ sourceKey: 'usage:feishu:feishu:authorization' })])
    )
  })

  it('does not synchronize unavailable snapshots', () => {
    const sync = vi.fn()
    syncSessionAccessNotificationSnapshots(
      {
        sessionAccessSnapshot: null,
        usageAccessSnapshot: null,
        orgPath
      },
      sync
    )
    expect(sync).not.toHaveBeenCalled()
  })

  it('uses an explicit clean snapshot to resolve one scope', () => {
    const sync = vi.fn()
    syncSessionAccessNotificationSnapshots(
      {
        sessionAccessSnapshot: { degraded: false, issues: [] },
        usageAccessSnapshot: null,
        orgPath
      },
      sync
    )
    expect(sync).toHaveBeenCalledWith('sessions-access', [])
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
