// Assistant-mode drafts (assistant-mode.md §5.5, §5.10): approval records for a post or a patrol's proposed task, and "always allow" grants.
import { createHash, randomUUID } from 'node:crypto'
import {
  ASSISTANT_PROPOSAL_SENTENCE_MAX,
  ASSISTANT_PROPOSAL_TASK_MAX,
  ASSISTANT_PROPOSAL_WHY_MAX
} from '@agentconnect.md/protocol'
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

/** `reply`: the turn's reply in an external place; `elsewhere`: a post the agent aimed at another place; `task`: a patrol's proposal. */
export type AssistantDraftKind = 'reply' | 'elsewhere' | 'task'

/** `post` is executed by the daemon itself; `task` by a sub-session it opens once approved (§5.10). */
export type AssistantDraftAction = 'post' | 'task'

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

/** Who or what the target is, resolved when the draft was written, so the card names the actual destination. */
export interface AssistantDraftDestination {
  /** The conversation's name, or the DM recipient's display name. */
  name: string | null
  /** The DM recipient's platform user id. */
  userId: string | null
  /** A link to the target thread, where the platform has one. */
  threadLink: string | null
}

/** The session a draft was written from: its lineage for the post's bookkeeping, and the source of a grant. */
export interface AssistantDraftSource {
  platform: string
  /** Absent for webchat, which has no platform integration. */
  integrationId: string | null
  channel: string
  /** The session's coordinate within the conversation. */
  thread: string
  transportScope: string | null
  sessionKey: string | null
  /** The session's outward id, for the console link on the card. */
  sessionId: string | null
  /** The conversation is a place a grant may name; false for a hook, a cron run or an agent call's synthetic one. */
  place: boolean
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

/** What a patrol proposes (§5.10): the card's sentence and reason, and the item at the version it was proposed against. */
export interface AssistantProposal {
  sentence: string
  why: string
  itemId: string
  itemVersion: number
}

export interface AssistantDraft {
  id: string
  agentId: string
  action: AssistantDraftAction
  kind: AssistantDraftKind
  target: AssistantDraftTarget
  /** The target is itself an external place: one approval covers it, and no grant ever does. */
  targetExternal: boolean
  /** The target is a direct message, which the card names as such. */
  targetDm: boolean
  destination: AssistantDraftDestination
  /** The post's exact text, or the task a proposal's sub-session carries out. */
  text: string
  /** Set on a `task` only. */
  proposal: AssistantProposal | null
  source: AssistantDraftSource | null
  approver: AssistantDraftApprover | null
  cardTs: string | null
  /** The card offers "always allow from here to there". */
  offerAlways: boolean
  /** The agent's grant generation when the draft was written; a grant from an older one is never honored. */
  grantEpoch: number
  status: AssistantDraftStatus
  /** Binds the action, the target and the text (a task: the task, the agent and the item's version); checked again before it runs. */
  hash: string
  createdAt: number
  expiresAt: number
  decidedAt: number | null
  decidedBy: string | null
  decidedByName: string | null
  settledAt: number | null
  messageId: string | null
  failure: string | null
  /** The sub-session an approved task runs in, recorded with the move to `executing`. */
  subsessionKey: string | null
}

export interface AssistantDraftCreate {
  id?: string
  agentId: string
  kind: AssistantDraftKind
  target: AssistantDraftTarget
  targetExternal?: boolean
  targetDm?: boolean
  destination?: Partial<AssistantDraftDestination>
  text: string
  source?: AssistantDraftSource | null
  approver?: AssistantDraftApprover | null
  offerAlways?: boolean
  now?: number
}

/** A patrol's proposal: the item's place is its target, and the task its text. */
export interface AssistantTaskCreate {
  id?: string
  agentId: string
  /** The item's place of origin, where the approved task runs and reports; webchat has no integration (''). */
  target: AssistantDraftTarget
  destination?: Partial<AssistantDraftDestination>
  task: string
  sentence: string
  why: string
  itemId: string
  itemVersion: number
  source: AssistantDraftSource
  approver?: AssistantDraftApprover | null
  now?: number
}

/** How an executing task ended: it reported back, it ended without reporting, or a restart cut it (§5.7 step 1). */
export type AssistantTaskOutcome = 'succeeded' | 'failed' | 'outcome_unknown'

/** A grant's two ends: the place a post is written from and the place it goes to. */
export interface AssistantGrantPlace {
  platform: string
  integrationId: string | null
  channel: string
}

/** One "always allow from here to there" grant as listed; `id` digests its pair of places. */
export interface AssistantPostGrant {
  id: string
  source: AssistantGrantPlace
  target: AssistantGrantPlace
  grantedBy: string | null
  grantedAt: number
}

/** A grant's stable name: a digest of its pair of places, the same key the table is unique on. */
export function assistantGrantId(source: AssistantGrantPlace, target: AssistantGrantPlace): string {
  const parts = [source, target].flatMap((place) => [place.platform, place.integrationId ?? '', place.channel])
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

export const ASSISTANT_DRAFT_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_draft (
        id TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('post', 'task')),
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'elsewhere', 'task')),
        targetPlatform TEXT NOT NULL,
        targetIntegrationId TEXT NOT NULL,
        targetChannel TEXT NOT NULL,
        targetThread TEXT,
        targetExternal INTEGER NOT NULL DEFAULT 0,
        targetDm INTEGER NOT NULL DEFAULT 0,
        targetName TEXT,
        targetUser TEXT,
        targetLink TEXT,
        text TEXT NOT NULL,
        sourcePlatform TEXT,
        sourceIntegrationId TEXT,
        sourceChannel TEXT,
        sourceThread TEXT,
        sourceTransportScope TEXT,
        sourceSessionKey TEXT,
        sourceSessionId TEXT,
        sourcePlace INTEGER NOT NULL DEFAULT 0,
        approverKind TEXT,
        approverIntegrationId TEXT,
        approverChannel TEXT,
        approverUserId TEXT,
        approverTeamId TEXT,
        approverConsoleUserId TEXT,
        cardTs TEXT,
        offerAlways INTEGER NOT NULL DEFAULT 0,
        grantEpoch INTEGER NOT NULL DEFAULT 0,
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
        failure TEXT,
        sentence TEXT,
        why TEXT,
        itemId TEXT,
        itemVersion INTEGER,
        subsessionKey TEXT
      );
      CREATE INDEX IF NOT EXISTS assistant_draft_by_status ON assistant_draft (agentId, status, expiresAt);
      CREATE INDEX IF NOT EXISTS assistant_draft_by_subsession ON assistant_draft (agentId, subsessionKey);
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
        grantEpoch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agentId, sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform, targetIntegrationId,
          targetChannel)
      );
      CREATE TABLE IF NOT EXISTS assistant_grant_epoch (
        agentId TEXT PRIMARY KEY,
        grantEpoch INTEGER NOT NULL
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

/** The digest that binds a proposal's action, task, executing identity and the item's version, so a changed row never runs. */
export function assistantTaskHash(agentId: string, itemId: string, itemVersion: number, task: string): string {
  const parts = ['task', agentId, itemId, itemVersion, task]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

type Row = Record<string, unknown>

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

function draftOf(row: Row): AssistantDraft {
  const sourcePlatform = str(row.sourcePlatform)
  const approverKind = str(row.approverKind)
  const action: AssistantDraftAction = row.action === 'task' ? 'task' : 'post'
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    action,
    kind: row.kind as AssistantDraftKind,
    target: {
      platform: String(row.targetPlatform),
      integrationId: String(row.targetIntegrationId),
      channel: String(row.targetChannel),
      thread: str(row.targetThread)
    },
    targetExternal: Number(row.targetExternal) === 1,
    targetDm: Number(row.targetDm) === 1,
    destination: { name: str(row.targetName), userId: str(row.targetUser), threadLink: str(row.targetLink) },
    text: String(row.text),
    proposal:
      action === 'task'
        ? {
            sentence: String(row.sentence ?? ''),
            why: String(row.why ?? ''),
            itemId: String(row.itemId ?? ''),
            itemVersion: Number(row.itemVersion ?? 0)
          }
        : null,
    source: sourcePlatform
      ? {
          platform: sourcePlatform,
          integrationId: str(row.sourceIntegrationId) || null,
          channel: String(row.sourceChannel ?? ''),
          thread: String(row.sourceThread ?? ''),
          transportScope: str(row.sourceTransportScope),
          sessionKey: str(row.sourceSessionKey),
          sessionId: str(row.sourceSessionId),
          place: Number(row.sourcePlace) === 1
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
    grantEpoch: Number(row.grantEpoch),
    status: row.status as AssistantDraftStatus,
    hash: String(row.hash),
    createdAt: Number(row.createdAt),
    expiresAt: Number(row.expiresAt),
    decidedAt: num(row.decidedAt),
    decidedBy: str(row.decidedBy),
    decidedByName: str(row.decidedByName),
    settledAt: num(row.settledAt),
    messageId: str(row.messageId),
    failure: str(row.failure),
    subsessionKey: str(row.subsessionKey)
  }
}

function grantOf(row: Row): AssistantPostGrant {
  const source = {
    platform: String(row.sourcePlatform),
    integrationId: str(row.sourceIntegrationId) || null,
    channel: String(row.sourceChannel)
  }
  const target = {
    platform: String(row.targetPlatform),
    integrationId: str(row.targetIntegrationId) || null,
    channel: String(row.targetChannel)
  }
  return {
    id: assistantGrantId(source, target),
    source,
    target,
    grantedBy: str(row.grantedBy),
    grantedAt: Number(row.grantedAt)
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
    const destination = input.destination ?? {}
    const row: Record<string, unknown> = {
      id,
      agentId: input.agentId,
      action: 'post',
      kind: input.kind,
      targetPlatform: target.platform,
      targetIntegrationId: target.integrationId,
      targetChannel: target.channel,
      targetThread: target.thread,
      targetExternal: input.targetExternal ? 1 : 0,
      targetDm: input.targetDm ? 1 : 0,
      targetName: destination.name ?? null,
      targetUser: destination.userId ?? null,
      targetLink: destination.threadLink ?? null,
      text,
      sourcePlatform: source?.platform ?? null,
      sourceIntegrationId: source ? (source.integrationId ?? '') : null,
      sourceChannel: source?.channel ?? null,
      sourceThread: source?.thread ?? null,
      sourceTransportScope: source?.transportScope ?? null,
      sourceSessionKey: source?.sessionKey ?? null,
      sourceSessionId: source?.sessionId ?? null,
      sourcePlace: source?.place ? 1 : 0,
      approverKind: approver?.kind ?? null,
      approverIntegrationId: approver?.integrationId ?? null,
      approverChannel: approver?.channel ?? null,
      approverUserId: approver?.userId ?? null,
      approverTeamId: approver?.teamId ?? null,
      approverConsoleUserId: approver?.consoleUserId ?? null,
      offerAlways: input.offerAlways ? 1 : 0,
      grantEpoch: await this.grantEpoch(input.agentId),
      status: 'awaiting_review',
      hash: assistantDraftHash(target, text),
      createdAt: now,
      expiresAt: now + ASSISTANT_DRAFT_TTL_MS
    }
    return await this.insert(id, row)
  }

  /** A patrol's proposal (§5.10): awaiting review for the same day a draft is, bound to the task, the agent and the item's version. */
  async createTask(input: AssistantTaskCreate): Promise<AssistantDraft> {
    const now = input.now ?? Date.now()
    const { target, task, sentence, why, source } = input
    if (!target.platform || !target.channel) throw new Error('a proposal needs the place it runs in')
    if (sentence.trim() === '') throw new Error('a proposal needs its sentence')
    if (task.trim() === '') throw new Error('a proposal needs its task')
    if (sentence.length > ASSISTANT_PROPOSAL_SENTENCE_MAX)
      throw new Error(`a proposal's sentence exceeds ${ASSISTANT_PROPOSAL_SENTENCE_MAX} characters`)
    if (why.length > ASSISTANT_PROPOSAL_WHY_MAX)
      throw new Error(`a proposal's reason exceeds ${ASSISTANT_PROPOSAL_WHY_MAX} characters`)
    if (task.length > ASSISTANT_PROPOSAL_TASK_MAX)
      throw new Error(`a proposal's task exceeds ${ASSISTANT_PROPOSAL_TASK_MAX} characters`)
    const id = input.id ?? randomUUID()
    const approver = input.approver ?? null
    const destination = input.destination ?? {}
    const row: Record<string, unknown> = {
      id,
      agentId: input.agentId,
      action: 'task',
      kind: 'task',
      targetPlatform: target.platform,
      targetIntegrationId: target.integrationId,
      targetChannel: target.channel,
      targetThread: target.thread,
      targetExternal: 0,
      targetDm: 0,
      targetName: destination.name ?? null,
      targetUser: null,
      targetLink: null,
      text: task,
      sourcePlatform: source.platform,
      sourceIntegrationId: source.integrationId ?? '',
      sourceChannel: source.channel,
      sourceThread: source.thread,
      sourceTransportScope: source.transportScope,
      sourceSessionKey: source.sessionKey,
      sourceSessionId: source.sessionId,
      sourcePlace: 0,
      approverKind: approver?.kind ?? null,
      approverIntegrationId: approver?.integrationId ?? null,
      approverChannel: approver?.channel ?? null,
      approverUserId: approver?.userId ?? null,
      approverTeamId: approver?.teamId ?? null,
      approverConsoleUserId: approver?.consoleUserId ?? null,
      offerAlways: 0,
      grantEpoch: await this.grantEpoch(input.agentId),
      status: 'awaiting_review',
      hash: assistantTaskHash(input.agentId, input.itemId, input.itemVersion, task),
      createdAt: now,
      expiresAt: now + ASSISTANT_DRAFT_TTL_MS,
      sentence,
      why,
      itemId: input.itemId,
      itemVersion: input.itemVersion
    }
    return await this.insert(id, row)
  }

  private async insert(id: string, row: Record<string, unknown>): Promise<AssistantDraft> {
    const columns = Object.keys(row)
    await this.db.query(
      `INSERT INTO assistant_draft (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row)
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

  /** Approve a post: awaiting review and unexpired → executing. False when someone else decided, or it expired. */
  async begin(id: string, by: { id: string | null; name: string | null }, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'executing', decidedAt = ?, decidedBy = ?, decidedByName = ?
       WHERE id = ? AND action = 'post' AND status = 'awaiting_review' AND expiresAt > ?`,
      [now, by.id, by.name, id, now]
    )
    return changes > 0
  }

  /** Approve a task: → executing with the sub-session it runs in, in one statement; `db` is the caller's transaction. */
  async beginTask(
    id: string,
    by: { id: string | null; name: string | null },
    subsessionKey: string,
    now = Date.now(),
    db: AssistantDraftDatabase = this.db
  ): Promise<boolean> {
    const { changes } = await db.query(
      `UPDATE assistant_draft SET status = 'executing', decidedAt = ?, decidedBy = ?, decidedByName = ?, subsessionKey = ?
       WHERE id = ? AND action = 'task' AND status = 'awaiting_review' AND expiresAt > ?`,
      [now, by.id, by.name, subsessionKey, id, now]
    )
    return changes > 0
  }

  /** An approved task that cannot start: awaiting review → failed, so it never runs. */
  async failTask(
    id: string,
    by: { id: string | null; name: string | null },
    failure: string,
    now = Date.now()
  ): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'failed', decidedAt = ?, decidedBy = ?, decidedByName = ?, settledAt = ?,
         failure = ?
       WHERE id = ? AND action = 'task' AND status = 'awaiting_review' AND expiresAt > ?`,
      [now, by.id, by.name, now, failure, id, now]
    )
    return changes > 0
  }

  /** How the task running in this sub-session ended; only an executing one settles, so the first outcome stands. */
  async settleTask(
    agentId: string,
    subsessionKey: string,
    status: AssistantTaskOutcome,
    failure: string | null,
    now = Date.now()
  ): Promise<AssistantDraft | undefined> {
    const settled = await this.settleTaskIn(this.db, agentId, subsessionKey, status, failure, now)
    return settled ? await this.taskBySubsession(agentId, subsessionKey) : undefined
  }

  /** {@link settleTask}'s compare-and-set alone, inside the caller's transaction. */
  async settleTaskIn(
    db: AssistantDraftDatabase,
    agentId: string,
    subsessionKey: string,
    status: AssistantTaskOutcome,
    failure: string | null,
    now: number
  ): Promise<boolean> {
    const { changes } = await db.query(
      `UPDATE assistant_draft SET status = ?, settledAt = ?, failure = ?
       WHERE agentId = ? AND subsessionKey = ? AND action = 'task' AND status = 'executing'`,
      [status, now, failure, agentId, subsessionKey]
    )
    return changes > 0
  }

  /** The task that runs in this sub-session, if one does. */
  async taskBySubsession(agentId: string, subsessionKey: string): Promise<AssistantDraft | undefined> {
    const row = (
      await this.db.query(`SELECT * FROM assistant_draft WHERE agentId = ? AND subsessionKey = ? AND action = 'task'`, [
        agentId,
        subsessionKey
      ])
    ).rows[0] as Row | undefined
    return row ? draftOf(row) : undefined
  }

  /** The tasks of these agents still executing, oldest first. */
  async executingTasks(agentIds: readonly string[]): Promise<AssistantDraft[]> {
    return await this.select(agentIds, "action = 'task' AND status = 'executing'", [])
  }

  /** Whether the patrol run in this session already proposed: a run proposes at most once. */
  async proposedFrom(agentId: string, sourceSessionKey: string): Promise<boolean> {
    const rows = (
      await this.db.query(
        `SELECT 1 AS hit FROM assistant_draft WHERE agentId = ? AND action = 'task' AND sourceSessionKey = ? LIMIT 1`,
        [agentId, sourceSessionKey]
      )
    ).rows
    return rows.length > 0
  }

  /** Discard: awaiting review and unexpired → denied. */
  async deny(id: string, by: { id: string | null; name: string | null }, now = Date.now()): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_draft SET status = 'denied', decidedAt = ?, decidedBy = ?, decidedByName = ?, settledAt = ?
       WHERE id = ? AND status = 'awaiting_review' AND expiresAt > ?`,
      [now, by.id, by.name, now, id, now]
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

  /** A post a restart or handover cut short may or may not have gone out: never retried (§5.10); a task recovers on its own path. */
  async recoverExecuting(agentIds: readonly string[], now = Date.now()): Promise<AssistantDraft[]> {
    const cut = await this.select(agentIds, "action = 'post' AND status = 'executing'", [])
    const recovered: AssistantDraft[] = []
    for (const draft of cut) {
      if (await this.settle(draft.id, 'outcome_unknown', { failure: 'interrupted' }, now)) {
        recovered.push({ ...draft, status: 'outcome_unknown' })
      }
    }
    return recovered
  }

  async deleteForAgent(agentId: string): Promise<number> {
    await this.db.query('DELETE FROM assistant_post_grant WHERE agentId = ?', [agentId])
    await this.db.query('DELETE FROM assistant_grant_epoch WHERE agentId = ?', [agentId])
    return (await this.db.query('DELETE FROM assistant_draft WHERE agentId = ?', [agentId])).changes
  }

  /** The agent's grant generation: bumped by every reset, so a grant from an older one is never honored. */
  async grantEpoch(agentId: string): Promise<number> {
    const row = (await this.db.query('SELECT grantEpoch FROM assistant_grant_epoch WHERE agentId = ?', [agentId]))
      .rows[0] as Row | undefined
    return row ? Number(row.grantEpoch) : 0
  }

  /** "Always allow from here to there", keyed by the pair of places and stamped with the generation it was offered in. */
  async grant(
    agentId: string,
    source: AssistantGrantPlace,
    target: AssistantGrantPlace,
    by: string | null,
    epoch: number,
    now = Date.now()
  ): Promise<boolean> {
    // A card from before a reset grants nothing; one racing a reset is written stale and never honored.
    if ((await this.grantEpoch(agentId)) !== epoch) return false
    const { changes } = await this.db.query(
      `INSERT INTO assistant_post_grant (agentId, sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform,
         targetIntegrationId, targetChannel, grantedBy, grantedAt, grantEpoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agentId, sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform, targetIntegrationId,
         targetChannel)
       DO UPDATE SET grantedBy = excluded.grantedBy, grantedAt = excluded.grantedAt, grantEpoch = excluded.grantEpoch
       WHERE assistant_post_grant.grantEpoch <> excluded.grantEpoch`,
      [
        agentId,
        source.platform,
        source.integrationId ?? '',
        source.channel,
        target.platform,
        target.integrationId ?? '',
        target.channel,
        by,
        now,
        epoch
      ]
    )
    return changes > 0
  }

  /** Whether a grant of the current generation covers this pair. */
  async granted(agentId: string, source: AssistantGrantPlace, target: AssistantGrantPlace): Promise<boolean> {
    const rows = (
      await this.db.query(
        `SELECT 1 AS hit FROM assistant_post_grant g WHERE g.agentId = ? AND g.sourcePlatform = ?
           AND g.sourceIntegrationId = ? AND g.sourceChannel = ? AND g.targetPlatform = ? AND g.targetIntegrationId = ?
           AND g.targetChannel = ?
           AND g.grantEpoch = COALESCE((SELECT e.grantEpoch FROM assistant_grant_epoch e WHERE e.agentId = ?), 0)`,
        [
          agentId,
          source.platform,
          source.integrationId ?? '',
          source.channel,
          target.platform,
          target.integrationId ?? '',
          target.channel,
          agentId
        ]
      )
    ).rows
    return rows.length > 0
  }

  /** Drafts still awaiting review and not yet due, the soonest to lapse first; proposals only when asked. */
  async listPending(
    agentId: string,
    limit: number,
    now = Date.now(),
    opts: { tasks?: boolean } = {}
  ): Promise<AssistantDraft[]> {
    const rows = (
      await this.db.query(
        `SELECT * FROM assistant_draft WHERE agentId = ? AND status = 'awaiting_review' AND expiresAt > ?${
          opts.tasks ? '' : " AND action = 'post'"
        }
         ORDER BY expiresAt, id LIMIT ?`,
        [agentId, now, limit]
      )
    ).rows as Row[]
    return rows.map(draftOf)
  }

  /** The grants of the current generation, newest first; an older one is never honored, so it is not listed. */
  async listGrants(agentId: string, limit: number): Promise<AssistantPostGrant[]> {
    const rows = (
      await this.db.query(
        `SELECT g.sourcePlatform, g.sourceIntegrationId, g.sourceChannel, g.targetPlatform, g.targetIntegrationId,
           g.targetChannel, g.grantedBy, g.grantedAt
         FROM assistant_post_grant g WHERE g.agentId = ?
           AND g.grantEpoch = COALESCE((SELECT e.grantEpoch FROM assistant_grant_epoch e WHERE e.agentId = ?), 0)
         ORDER BY g.grantedAt DESC, g.sourceChannel, g.targetChannel LIMIT ?`,
        [agentId, agentId, limit]
      )
    ).rows as Row[]
    return rows.map(grantOf)
  }

  /** Revoke the grant this digest names, whatever its generation; false when there is none. */
  async revokeGrant(agentId: string, grantId: string): Promise<boolean> {
    const rows = (
      await this.db.query(
        `SELECT sourcePlatform, sourceIntegrationId, sourceChannel, targetPlatform, targetIntegrationId, targetChannel,
           grantedBy, grantedAt FROM assistant_post_grant WHERE agentId = ?`,
        [agentId]
      )
    ).rows as Row[]
    const grant = rows.map(grantOf).find((g) => g.id === grantId)
    if (!grant) return false
    const { changes } = await this.db.query(
      `DELETE FROM assistant_post_grant WHERE agentId = ? AND sourcePlatform = ? AND sourceIntegrationId = ?
         AND sourceChannel = ? AND targetPlatform = ? AND targetIntegrationId = ? AND targetChannel = ?`,
      [
        agentId,
        grant.source.platform,
        grant.source.integrationId ?? '',
        grant.source.channel,
        grant.target.platform,
        grant.target.integrationId ?? '',
        grant.target.channel
      ]
    )
    return changes > 0
  }

  /** Grants end whenever assistant mode is switched off or on: the generation moves on, so no pending card can grant again. */
  async resetGrants(agentId: string): Promise<number> {
    await this.db.query(
      `INSERT INTO assistant_grant_epoch (agentId, grantEpoch) VALUES (?, 1)
       ON CONFLICT (agentId) DO UPDATE SET grantEpoch = assistant_grant_epoch.grantEpoch + 1`,
      [agentId]
    )
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
