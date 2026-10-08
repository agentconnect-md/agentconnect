// Assistant-mode drafts (assistant-mode.md §5.5, §5.10): approval records whose one action is a post, and "always allow" grants.
import { createHash, randomUUID } from 'node:crypto'
import type { StoreQueryResult } from './store-database.js'

export const ASSISTANT_DRAFT_STATUSES = [
  'awaiting_review',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'denied',
  'expired'
] as const
export type AssistantDraftStatus = (typeof ASSISTANT_DRAFT_STATUSES)[number]

/** `reply`: the turn's reply in an external place; `elsewhere`: a post the agent aimed at another place. */
export type AssistantDraftKind = 'reply' | 'elsewhere'

/** An approved draft is posted within a day or never (assistant-mode.md §5.5). */
export const ASSISTANT_DRAFT_TTL_MS = 24 * 60 * 60_000
/** Slack's own message ceiling; a longer text could never post unchanged. */
export const ASSISTANT_DRAFT_TEXT_MAX = 40_000

/** A conversation a draft posts into, addressed through the agent's own integration. */
export interface AssistantDraftTarget {
  platform: string
  integrationId: string
  channel: string
  /** The thread the text lands in; null posts at the conversation's root. */
  thread: string | null
}

/** The place a draft was written from; absent for a session with no place of its own (hook, cron). */
export interface AssistantDraftSource {
  platform: string
  /** Absent for webchat, which has no platform integration. */
  integrationId: string | null
  channel: string
  sessionKey: string | null
  /** The session's outward id, for the console link on the card. */
  sessionId: string | null
}

/** Who approves: a member addressed in their DM, or everyone in the agent's fallback conversation. */
export interface AssistantDraftApprover {
  kind: 'member' | 'conversation'
  /** The integration the card is posted and clicked through. */
  integrationId: string
  /** The conversation the card lands in: the member's DM, or the fallback conversation. */
  channel: string
  userId: string | null
  teamId: string | null
  /** Set when the control plane chose the member; a click is then re-verified there. */
  consoleUserId: string | null
}

export interface AssistantDraft {
  id: string
  agentId: string
  action: 'post'
  kind: AssistantDraftKind
  target: AssistantDraftTarget
  /** The target is itself an external place: one approval covers it, and no grant ever does. */
  targetExternal: boolean
  /** The target is a direct message, which the card names as such. */
  targetDm: boolean
  text: string
  source: AssistantDraftSource | null
  approver: AssistantDraftApprover | null
  cardTs: string | null
  /** The card offers "always allow from here to there". */
  offerAlways: boolean
  status: AssistantDraftStatus
  /** Binds the action, the target and the text; checked again before the post. */
  hash: string
  createdAt: number
  expiresAt: number
  decidedAt: number | null
  decidedBy: string | null
  decidedByName: string | null
  settledAt: number | null
  messageId: string | null
  failure: string | null
}

export interface AssistantDraftCreate {
  id?: string
  agentId: string
  kind: AssistantDraftKind
  target: AssistantDraftTarget
  targetExternal?: boolean
  targetDm?: boolean
  text: string
  source?: AssistantDraftSource | null
  approver?: AssistantDraftApprover | null
  offerAlways?: boolean
  now?: number
}

/** A grant's two ends: the place a post is written from and the place it goes to. */
export interface AssistantGrantPlace {
  platform: string
  integrationId: string | null
  channel: string
}

export const ASSISTANT_DRAFT_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_draft (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('post')),
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'elsewhere')),
        targetPlatform TEXT NOT NULL,
        targetIntegrationId TEXT NOT NULL,
        targetChannel TEXT NOT NULL,
        targetThread TEXT,
        targetExternal INTEGER NOT NULL DEFAULT 0,
        targetDm INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        sourcePlatform TEXT,
        sourceIntegrationId TEXT,
        sourceChannel TEXT,
        sourceSessionKey TEXT,
        sourceSessionId TEXT,
        approverKind TEXT,
        approverIntegrationId TEXT,
        approverChannel TEXT,
        approverUserId TEXT,
        approverTeamId TEXT,
        approverConsoleUserId TEXT,
        cardTs TEXT,
        offerAlways INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('awaiting_review', 'executing', 'succeeded', 'failed',
          'outcome_unknown', 'denied', 'expired')),
        hash TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        decidedAt INTEGER,
        decidedBy TEXT,
        decidedByName TEXT,
        settledAt INTEGER,
        messageId TEXT,
        failure TEXT
      );
      CREATE INDEX IF NOT EXISTS assistant_draft_by_status ON assistant_draft (agentId, status, expiresAt);
      CREATE TABLE IF NOT EXISTS assistant_post_grant (
        agentId TEXT NOT NULL,
        sourcePlatform TEXT NOT NULL,
        sourceIntegrationId TEXT NOT NULL DEFAULT '',
        sourceChannel TEXT NOT NULL,
        targetPlatform TEXT NOT NULL,
        targetIntegrationId TEXT NOT NULL,
        targetChannel TEXT NOT NULL,
        grantedBy TEXT,
        grantedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform, targetIntegrationId,
          targetChannel)
      );
`

/** What the ledger needs from the store. */
export interface AssistantDraftDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

/** The digest that binds a draft's action, target and text, so a changed row is never posted. */
export function assistantDraftHash(target: AssistantDraftTarget, text: string): string {
  const parts = ['post', target.platform, target.integrationId, target.channel, target.thread ?? '', text]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

type Row = Record<string, unknown>

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

function draftOf(row: Row): AssistantDraft {
  const sourcePlatform = str(row.sourcePlatform)
  const approverKind = str(row.approverKind)
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    action: 'post',
    kind: row.kind as AssistantDraftKind,
    target: {
      platform: String(row.targetPlatform),
      integrationId: String(row.targetIntegrationId),
      channel: String(row.targetChannel),
      thread: str(row.targetThread)
    },
    targetExternal: Number(row.targetExternal) === 1,
    targetDm: Number(row.targetDm) === 1,
    text: String(row.text),
    source: sourcePlatform
      ? {
          platform: sourcePlatform,
          integrationId: str(row.sourceIntegrationId) || null,
          channel: String(row.sourceChannel ?? ''),
          sessionKey: str(row.sourceSessionKey),
          sessionId: str(row.sourceSessionId)
        }
      : null,
    approver:
      approverKind === 'member' || approverKind === 'conversation'
        ? {
            kind: approverKind,
            integrationId: String(row.approverIntegrationId),
            channel: String(row.approverChannel),
            userId: str(row.approverUserId),
            teamId: str(row.approverTeamId),
            consoleUserId: str(row.approverConsoleUserId)
          }
        : null,
    cardTs: str(row.cardTs),
    offerAlways: Number(row.offerAlways) === 1,
    status: row.status as AssistantDraftStatus,
    hash: String(row.hash),
    createdAt: Number(row.createdAt),
    expiresAt: Number(row.expiresAt),
    decidedAt: num(row.decidedAt),
    decidedBy: str(row.decidedBy),
    decidedByName: str(row.decidedByName),
    settledAt: num(row.settledAt),
    messageId: str(row.messageId),
    failure: str(row.failure)
  }
}

export class AssistantDraftLedger {
  constructor(private readonly db: AssistantDraftDatabase) {}

  async create(input: AssistantDraftCreate): Promise<AssistantDraft> {
    const now = input.now ?? Date.now()
    const { target, text } = input
    if (!target.platform || !target.integrationId || !target.channel) {
      throw new Error('assistant draft target needs a platform, an integration and a channel')
    }
    if (text.trim() === '') throw new Error('assistant draft text must not be empty')
    if (text.length > ASSISTANT_DRAFT_TEXT_MAX) {
      throw new Error(`assistant draft text exceeds ${ASSISTANT_DRAFT_TEXT_MAX} characters`)
    }
    const id = input.id ?? randomUUID()
    const source = input.source ?? null
    const approver = input.approver ?? null
    await this.db.query(
      `INSERT INTO assistant_draft (id, agentId, action, kind, targetPlatform, targetIntegrationId, targetChannel,
         targetThread, targetExternal, targetDm, text, sourcePlatform, sourceIntegrationId, sourceChannel, sourceSessionKey,
         sourceSessionId, approverKind, approverIntegrationId, approverChannel, approverUserId, approverTeamId,
         approverConsoleUserId, offerAlways, status, hash, createdAt, expiresAt)
       VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_review', ?, ?, ?)`,
      [
        id,
        input.agentId,
        input.kind,
        target.platform,
        target.integrationId,
        target.channel,
        target.thread,
        input.targetExternal ? 1 : 0,
        input.targetDm ? 1 : 0,
        text,
        source?.platform ?? null,
        source ? (source.integrationId ?? '') : null,
        source?.channel ?? null,
        source?.sessionKey ?? null,
        source?.sessionId ?? null,
        approver?.kind ?? null,
        approver?.integrationId ?? null,
        approver?.channel ?? null,
        approver?.userId ?? null,
        approver?.teamId ?? null,
        approver?.consoleUserId ?? null,
        input.offerAlways ? 1 : 0,
        assistantDraftHash(target, text),
        now,
        now + ASSISTANT_DRAFT_TTL_MS
      ]
    )
    return (await this.get(id))!
  }

  /** By id alone: a card click names only the draft. */
  async get(id: string): Promise<AssistantDraft | undefined> {
    const row = (await this.db.query('SELECT * FROM assistant_draft WHERE id = ?', [id])).rows[0] as Row | undefined
    return row ? draftOf(row) : undefined
  }

  /** Records the posted card, so a later settlement can rewrite it. */
  async setCard(id: string, ts: string): Promise<boolean> {
    return (await this.db.query('UPDATE assistant_draft SET cardTs = ? WHERE id = ?', [ts, id])).changes > 0
  }

  /** Approve: awaiting review and unexpired → executing. False when someone else decided, or it expired. */
  async begin(id: string, by: { id: string | null; name: string | null }, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'executing', decidedAt = ?, decidedBy = ?, decidedByName = ?
       WHERE id = ? AND status = 'awaiting_review' AND expiresAt > ?`,
      [now, by.id, by.name, id, now]
    )
    return changes > 0
  }

  /** Discard: awaiting review → denied. */
  async deny(id: string, by: { id: string | null; name: string | null }, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'denied', decidedAt = ?, decidedBy = ?, decidedByName = ?, settledAt = ?
       WHERE id = ? AND status = 'awaiting_review'`,
      [now, by.id, by.name, now, id]
    )
    return changes > 0
  }

  /** The post's outcome; only an executing draft settles, so a recovered one keeps `outcome_unknown`. */
  async settle(
    id: string,
    status: 'succeeded' | 'failed' | 'outcome_unknown',
    detail: { messageId?: string; failure?: string } = {},
    now = Date.now()
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = ?, settledAt = ?, messageId = ?, failure = ?
       WHERE id = ? AND status = 'executing'`,
      [status, now, detail.messageId ?? null, detail.failure ?? null, id]
    )
    return changes > 0
  }

  /** Expire one draft past its deadline; false when it is not awaiting review or not yet due. */
  async expire(id: string, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'expired', settledAt = ?
       WHERE id = ? AND status = 'awaiting_review' AND expiresAt <= ?`,
      [now, id, now]
    )
    return changes > 0
  }

  /** Expire every due draft of these agents and return the ones this call expired. */
  async expireDue(agentIds: readonly string[], now = Date.now()): Promise<AssistantDraft[]> {
    const due = await this.select(agentIds, "status = 'awaiting_review' AND expiresAt <= ?", [now])
    const expired: AssistantDraft[] = []
    for (const draft of due) if (await this.expire(draft.id, now)) expired.push({ ...draft, status: 'expired' })
    return expired
  }

  /** An execution a restart or handover cut short may or may not have posted: never retried (§5.10). */
  async recoverExecuting(agentIds: readonly string[], now = Date.now()): Promise<AssistantDraft[]> {
    const cut = await this.select(agentIds, "status = 'executing'", [])
    const recovered: AssistantDraft[] = []
    for (const draft of cut) {
      if (await this.settle(draft.id, 'outcome_unknown', { failure: 'interrupted' }, now)) {
        recovered.push({ ...draft, status: 'outcome_unknown' })
      }
    }
    return recovered
  }

  async deleteForAgent(agentId: string): Promise<number> {
    await this.clearGrants(agentId)
    return (await this.db.query('DELETE FROM assistant_draft WHERE agentId = ?', [agentId])).changes
  }

  /** "Always allow from here to there": keyed by the pair of places, never covering another source. */
  async grant(
    agentId: string,
    source: AssistantGrantPlace,
    target: AssistantGrantPlace,
    by: string | null,
    now = Date.now()
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_post_grant (agentId, sourcePlatform, sourceIntegrationId, sourceChannel,
         targetPlatform, targetIntegrationId, targetChannel, grantedBy, grantedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        agentId,
        source.platform,
        source.integrationId ?? '',
        source.channel,
        target.platform,
        target.integrationId ?? '',
        target.channel,
        by,
        now
      ]
    )
    return changes > 0
  }

  async granted(agentId: string, source: AssistantGrantPlace, target: AssistantGrantPlace): Promise<boolean> {
    const rows = (
      await this.db.query(
        `SELECT 1 AS hit FROM assistant_post_grant WHERE agentId = ? AND sourcePlatform = ? AND sourceIntegrationId = ?
           AND sourceChannel = ? AND targetPlatform = ? AND targetIntegrationId = ? AND targetChannel = ?`,
        [
          agentId,
          source.platform,
          source.integrationId ?? '',
          source.channel,
          target.platform,
          target.integrationId ?? '',
          target.channel
        ]
      )
    ).rows
    return rows.length > 0
  }

  /** Grants end when assistant mode is switched off. */
  async clearGrants(agentId: string): Promise<number> {
    return (await this.db.query('DELETE FROM assistant_post_grant WHERE agentId = ?', [agentId])).changes
  }

  private async select(agentIds: readonly string[], where: string, params: unknown[]): Promise<AssistantDraft[]> {
    if (agentIds.length === 0) return []
    const marks = agentIds.map(() => '?').join(', ')
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_draft WHERE agentId IN (${marks}) AND ${where} ORDER BY createdAt, id`,
        [...agentIds, ...params]
      )
    ).rows as Row[]
    return rows.map(draftOf)
  }
}
