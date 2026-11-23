import { z } from 'zod'
import { OrgHistoryRetention } from './register.js'

/** Hard cap on the orgs one confirmation names; a sweep with more chunks. */
export const HISTORY_RETENTION_CONFIRM_MAX = 500

const OrgIdField = z.string().min(1).max(64)

// D→C REQ, install-wide: the orgs a retention sweep is about to reclaim sessions for (org-session-policy.md, Reclaim).
export const HistoryRetentionConfirm = z.object({
  orgIds: z.array(OrgIdField).min(1).max(HISTORY_RETENTION_CONFIRM_MAX)
})
export type HistoryRetentionConfirm = z.infer<typeof HistoryRetentionConfirm>

// C→D REP: each asked org lands in exactly one list; `denied` is an org this daemon serves no agent in.
export const HistoryRetentionConfirmResult = z.object({
  entries: z.array(OrgHistoryRetention).max(HISTORY_RETENTION_CONFIRM_MAX),
  noPolicy: z.array(OrgIdField).max(HISTORY_RETENTION_CONFIRM_MAX),
  denied: z.array(OrgIdField).max(HISTORY_RETENTION_CONFIRM_MAX)
})
export type HistoryRetentionConfirmResult = z.infer<typeof HistoryRetentionConfirmResult>
