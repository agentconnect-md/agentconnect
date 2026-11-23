// `history-retention/confirm` and the reclaim switch (org-session-policy.md, Reclaim).
import { describe, expect, it } from 'vitest'
import {
  HISTORY_RETENTION_CONFIRM_FEATURE,
  HISTORY_RETENTION_CONFIRM_MAX,
  HistoryRetentionConfirm,
  HistoryRetentionConfirmResult,
  INSTALL_WIDE_FRAME_TYPES,
  ORG_HISTORY_RECLAIM_FEATURE,
  OrgHistoryRetentionSnapshot,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  isFrameType
} from '../index.js'

const CORR_ID = '22222222-2222-4222-8222-222222222222'

describe('history-retention/confirm frames', () => {
  it('pins the features', () => {
    expect(HISTORY_RETENTION_CONFIRM_FEATURE).toBe('history-retention-confirm-v1')
    expect(ORG_HISTORY_RECLAIM_FEATURE).toBe('org-history-reclaim-v1')
  })

  it('asks for one to the cap of orgs', () => {
    expect(HistoryRetentionConfirm.safeParse({ orgIds: [] }).success).toBe(false)
    expect(HistoryRetentionConfirm.safeParse({ orgIds: ['org-a'] }).success).toBe(true)
    const many = Array.from({ length: HISTORY_RETENTION_CONFIRM_MAX + 1 }, (_, i) => `org-${i}`)
    expect(HistoryRetentionConfirm.safeParse({ orgIds: many }).success).toBe(false)
  })

  it('round-trips the request and its reply as install-wide frames', () => {
    const request = decodeEnvelope(encode(buildEnvelope('history-retention/confirm', { orgIds: ['org-a', 'org-b'] })))
    if (!request.ok || !isFrame('history-retention/confirm')(request.frame)) throw new Error('expected a request')
    expect(request.frame.payload.orgIds).toEqual(['org-a', 'org-b'])
    const result = {
      entries: [{ orgId: 'org-a', revision: 3, historyRetentionDays: null }],
      noPolicy: ['org-b'],
      denied: ['org-c']
    }
    const reply = decodeEnvelope(encode(buildEnvelope('history-retention/confirm/result', result, { corr: CORR_ID })))
    if (!reply.ok || !isFrame('history-retention/confirm/result')(reply.frame)) throw new Error('expected a reply')
    expect(HistoryRetentionConfirmResult.parse(reply.frame.payload)).toEqual(result)
    for (const type of ['history-retention/confirm', 'history-retention/confirm/result']) {
      expect(isFrameType(type)).toBe(true)
      expect(INSTALL_WIDE_FRAME_TYPES.has(type as never)).toBe(true)
    }
  })

  it('reads the reclaim switch beside the snapshot, absent from an older CP', () => {
    expect(OrgHistoryRetentionSnapshot.parse({ orgIds: [], entries: [], reclaim: true }).reclaim).toBe(true)
    expect(OrgHistoryRetentionSnapshot.parse({ orgIds: [], entries: [] }).reclaim).toBeUndefined()
  })
})
