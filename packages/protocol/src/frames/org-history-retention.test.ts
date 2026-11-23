// `register/ok.orgHistoryRetention` and its push entry (org-session-policy.md, History retention).
import { describe, expect, it } from 'vitest'
import { CONFIG_KEY_ORG_HISTORY_RETENTION, ORG_HISTORY_RETENTION_FEATURE } from '../consts.js'
import { OrgHistoryRetention, RegisterOk } from './register.js'

const base = { routingEpoch: 1, assignments: [], crons: [], leases: [], drop: { assignments: [], crons: [] } }

describe('org history retention wire', () => {
  it('pins the feature and the push key', () => {
    expect(ORG_HISTORY_RETENTION_FEATURE).toBe('org-history-retention-v1')
    expect(CONFIG_KEY_ORG_HISTORY_RETENTION).toBe('sessions.orgHistoryRetention')
  })

  it('parses a register/ok with and without the snapshot, so either side may be older', () => {
    const snapshot = {
      orgIds: ['org-a', 'org-b'],
      entries: [{ orgId: 'org-a', revision: 2, historyRetentionDays: null }]
    }
    expect(RegisterOk.parse({ ...base, orgHistoryRetention: snapshot }).orgHistoryRetention).toEqual(snapshot)
    expect(RegisterOk.parse(base).orgHistoryRetention).toBeUndefined()
  })

  it('refuses a zero revision or zero days', () => {
    expect(OrgHistoryRetention.safeParse({ orgId: 'org-a', revision: 0, historyRetentionDays: 7 }).success).toBe(false)
    expect(OrgHistoryRetention.safeParse({ orgId: 'org-a', revision: 1, historyRetentionDays: 0 }).success).toBe(false)
  })
})
