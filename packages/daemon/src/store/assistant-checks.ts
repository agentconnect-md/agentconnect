// A follow-up's check state and check log (assistant-mode.md §5.12): which next check was taken, the failure streak and its backoff, the check in flight, messages and an event wake (§5.14) waiting for it.
import { FollowUpEventKind } from '@agentconnect.md/protocol'
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** After this many failed checks in a row a follow-up is checked no more until it is messaged. */
export const CHECK_MAX_FAILURES = 5

/** The wait after the `failures`-th failure in a row: min(60, 2ⁿ) minutes. */
export const checkBackoffMs = (failures: number): number => Math.min(60, 2 ** failures) * 60_000

/** Checks kept per follow-up in its log, besides every check the budget window still counts. */
export const ASSISTANT_CHECKS_KEPT = 50

/** The rolling window `dailyCheckBudget` counts check starts in. */
export const CHECK_BUDGET_WINDOW_MS = 24 * 60 * 60_000

export interface AssistantCheckState {
  agentId: string
  itemId: string
  /** The `nextCheck` the last finished scheduled check was for; that value is never checked again. */
  checkedNextCheck: number | null
  /** Failed checks in a row; a finished check resets it. */
  failures: number
  /** No scheduled check before this, after a failure. */
  retryAt: number | null
  /** Checks stopped after {@link CHECK_MAX_FAILURES} failures, until the follow-up is messaged. */
  stopped: boolean
  stoppedNextCheck: number | null
  /** The follow-up's session while a check runs in it, and the scheduled `nextCheck` it was started for, if any. */
  runningKey: string | null
  runningNextCheck: number | null
  /** The observation version when that check started, so any daemon settling it can tell whether it recorded anything. */
  runningObservationVersion: number | null
  /** The report that check kept for its end, so a replay on another daemon still delivers it. */
  runningReport: string | null
  /** The running check's number in the log, which also names its reports. */
  runningCheck: number | null
  runningSince: number | null
  /** JSON of the messages the running check took and the people they speak for. */
  runningInput: string | null
  /** JSON of messages from the owning session waiting for the running check to end. */
  pendingMessages: string | null
  /** The last wake applied, so a retried one starts no second check. */
  wakeId: number
  /** A wake waiting for a check: due from this time, with the events it folds and when the latest arrived. */
  wakeAt: number | null
  wakeKinds: FollowUpEventKind[]
  wakeLatestAt: number | null
  /** When the latest check a wake started began, which spaces woken checks apart. */
  lastWokenAt: number | null
  /** The events the running check took. */
  runningWake: FollowUpEventKind[]
  updatedAt: number
}

/** What started a check: its scheduled time, a message, or events on what it watches (§5.14). */
export const ASSISTANT_CHECK_STARTS = ['time', 'message', 'wake'] as const
export type AssistantCheckStart = (typeof ASSISTANT_CHECK_STARTS)[number]

/** A follow-up whose scheduled check is due and not yet taken. */
export interface AssistantCheckDue {
  itemId: string
  nextCheck: number
}

/** One check of a follow-up, as its log keeps it. */
export interface AssistantCheck {
  itemId: string
  checkNo: number
  startedAt: number
  endedAt: number | null
  observation: string | null
  reported: boolean
  /** What started it; null on a check logged before this was kept. */
  startedBy: AssistantCheckStart | null
  /** The events it took from a wake, whatever started it. */
  events: FollowUpEventKind[]
}

/** How a recorded wake landed: applied before, answered by the check running since before its events, or waiting for a check. */
export type AssistantWakeOutcome = 'duplicate' | 'answered' | 'recorded'

export const ASSISTANT_CHECK_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_check_state (
        agentId TEXT NOT NULL,
        itemId TEXT NOT NULL,
        checkedNextCheck INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,
        retryAt INTEGER,
        stopped INTEGER NOT NULL DEFAULT 0,
        stoppedNextCheck INTEGER,
        runningKey TEXT,
        runningNextCheck INTEGER,
        runningObservationVersion INTEGER,
        runningReport TEXT,
        runningCheck INTEGER,
        runningSince INTEGER,
        runningInput TEXT,
        pendingMessages TEXT,
        wakeId INTEGER NOT NULL DEFAULT 0,
        wakeAt INTEGER,
        wakeKinds TEXT,
        wakeLatestAt INTEGER,
        lastWokenAt INTEGER,
        runningWake TEXT,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (agentId, itemId)
      );
      CREATE TABLE IF NOT EXISTS assistant_check (
        agentId TEXT NOT NULL,
        itemId TEXT NOT NULL,
        checkNo INTEGER NOT NULL,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        observation TEXT,
        reported INTEGER NOT NULL DEFAULT 0,
        historyRead INTEGER NOT NULL DEFAULT 0,
        startedBy TEXT,
        events TEXT,
        PRIMARY KEY (agentId, itemId, checkNo)
      );
      CREATE INDEX IF NOT EXISTS assistant_check_by_agent ON assistant_check (agentId, startedAt);
`

/** What the check state needs from the store; a check's start takes its state and its log row in one transaction. */
export interface AssistantCheckDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
}

type Row = Record<string, unknown>

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

/** A stored comma list of event kinds, unknown ones dropped. */
export function eventsOf(value: unknown): FollowUpEventKind[] {
  if (typeof value !== 'string' || value === '') return []
  return value.split(',').filter((kind): kind is FollowUpEventKind => FollowUpEventKind.safeParse(kind).success)
}

/** Two event lists as one, in arrival order, each once. */
export function mergeEvents(a: readonly FollowUpEventKind[], b: readonly FollowUpEventKind[]): FollowUpEventKind[] {
  return [...new Set([...a, ...b])]
}

const eventsText = (kinds: readonly FollowUpEventKind[]): string | null => (kinds.length === 0 ? null : kinds.join(','))

function stateOf(row: Row): AssistantCheckState {
  return {
    agentId: String(row.agentId),
    itemId: String(row.itemId),
    checkedNextCheck: num(row.checkedNextCheck),
    failures: Number(row.failures),
    retryAt: num(row.retryAt),
    stopped: Number(row.stopped) === 1,
    stoppedNextCheck: num(row.stoppedNextCheck),
    runningKey: str(row.runningKey),
    runningNextCheck: num(row.runningNextCheck),
    runningObservationVersion: num(row.runningObservationVersion),
    runningReport: str(row.runningReport),
    runningCheck: num(row.runningCheck),
    runningSince: num(row.runningSince),
    runningInput: str(row.runningInput),
    pendingMessages: str(row.pendingMessages),
    wakeId: Number(row.wakeId ?? 0),
    wakeAt: num(row.wakeAt),
    wakeKinds: eventsOf(row.wakeKinds),
    wakeLatestAt: num(row.wakeLatestAt),
    lastWokenAt: num(row.lastWokenAt),
    runningWake: eventsOf(row.runningWake),
    updatedAt: Number(row.updatedAt)
  }
}

// Every running field, cleared when a check ends.
const CLEAR_RUNNING =
  'runningKey = NULL, runningNextCheck = NULL, runningObservationVersion = NULL, runningReport = NULL, ' +
  'runningCheck = NULL, runningSince = NULL, runningInput = NULL, runningWake = NULL'

export class AssistantCheckLedger {
  constructor(private readonly db: AssistantCheckDatabase) {}

  /** Open follow-ups whose next check is due, never taken for that value, past any backoff, not stopped and not checking since `staleBefore`; follow-ups before first looks, then earliest first. */
  async due(agentId: string, now: number, limit: number, staleBefore = 0): Promise<AssistantCheckDue[]> {
    const rows = (
      await this.db.query(
        `SELECT i.id AS itemId, i.nextCheck FROM assistant_item i
           LEFT JOIN assistant_check_state p ON p.agentId = i.agentId AND p.itemId = i.id
          WHERE i.agentId = ? AND i.status IN ('active', 'waiting') AND i.nextCheck IS NOT NULL AND i.nextCheck <= ?
            AND (p.itemId IS NULL OR (
              (p.checkedNextCheck IS NULL OR p.checkedNextCheck <> i.nextCheck)
              AND (p.retryAt IS NULL OR p.retryAt <= ?)
              AND p.stopped = 0 AND (p.runningKey IS NULL OR p.runningSince < ?)))
          ORDER BY CASE WHEN i.firstLook IS NULL THEN 0 ELSE 1 END, i.nextCheck, i.id LIMIT ?`,
        [agentId, now, now, staleBefore, limit]
      )
    ).rows as Row[]
    return rows.map((row) => ({ itemId: String(row.itemId), nextCheck: Number(row.nextCheck) }))
  }

  /** Open follow-ups a wake made due (§5.14): past any backoff, not stopped, none running, and no woken check of theirs started after `spacedBefore`. */
  async wokenDue(
    agentId: string,
    now: number,
    limit: number,
    staleBefore: number,
    spacedBefore: number
  ): Promise<string[]> {
    const rows = (
      await this.db.query(
        `SELECT p.itemId FROM assistant_check_state p
           JOIN assistant_item i ON i.agentId = p.agentId AND i.id = p.itemId
          WHERE p.agentId = ? AND i.status IN ('active', 'waiting') AND i.firstLook IS NULL
            AND p.wakeAt IS NOT NULL AND p.wakeAt <= ?
            AND (p.retryAt IS NULL OR p.retryAt <= ?) AND p.stopped = 0
            AND (p.runningKey IS NULL OR p.runningSince < ?)
            AND (p.lastWokenAt IS NULL OR p.lastWokenAt <= ?)
          ORDER BY p.wakeAt, p.itemId LIMIT ?`,
        [agentId, now, now, staleBefore, spacedBefore, limit]
      )
    ).rows as Row[]
    return rows.map((row) => String(row.itemId))
  }

  /** Record one wake: once per `wakeId`, dropped when the check running since before its latest event answers it, else folded into the waiting one. */
  async recordWake(
    agentId: string,
    itemId: string,
    wake: { wakeId: number; kinds: FollowUpEventKind[]; latestAt: number; now: number; staleBefore: number }
  ): Promise<AssistantWakeOutcome> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await ensure(this.db, agentId, itemId, wake.now)
      const state = await this.get(agentId, itemId)
      if (!state || wake.wakeId <= state.wakeId) return 'duplicate'
      const running = state.runningKey !== null && state.runningSince !== null && state.runningSince >= wake.staleBefore
      const answered = running && wake.latestAt < state.runningSince!
      const kinds = answered ? state.wakeKinds : mergeEvents(state.wakeKinds, wake.kinds)
      const latest = answered ? state.wakeLatestAt : Math.max(state.wakeLatestAt ?? 0, wake.latestAt)
      const { changes } = await this.db.query(
        `UPDATE assistant_check_state SET wakeId = ?, wakeAt = ?, wakeKinds = ?, wakeLatestAt = ?, updatedAt = ?
         WHERE agentId = ? AND itemId = ? AND wakeId = ?`,
        [
          wake.wakeId,
          answered ? state.wakeAt : (state.wakeAt ?? wake.now),
          eventsText(kinds),
          latest,
          wake.now,
          agentId,
          itemId,
          state.wakeId
        ]
      )
      if (changes > 0) return answered ? 'answered' : 'recorded'
    }
    throw new Error('the wake could not be recorded')
  }

  /** Open follow-ups with messages waiting, no check running and past any backoff, oldest first. */
  async withPendingMessages(agentId: string, now: number, limit: number): Promise<string[]> {
    const rows = (
      await this.db.query(
        `SELECT p.itemId FROM assistant_check_state p
           JOIN assistant_item i ON i.agentId = p.agentId AND i.id = p.itemId
          WHERE p.agentId = ? AND p.pendingMessages IS NOT NULL AND p.runningKey IS NULL
            AND (p.retryAt IS NULL OR p.retryAt <= ?) AND p.stopped = 0 AND i.status IN ('active', 'waiting')
          ORDER BY p.updatedAt, p.itemId LIMIT ?`,
        [agentId, now, limit]
      )
    ).rows as Row[]
    return rows.map((row) => String(row.itemId))
  }

  async get(agentId: string, itemId: string): Promise<AssistantCheckState | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_check_state WHERE agentId = ? AND itemId = ?', [agentId, itemId])
    ).rows[0] as Row | undefined
    return row ? stateOf(row) : undefined
  }

  /** The follow-up a check is running in this session for, while it runs. */
  async byRunningKey(agentId: string, runningKey: string): Promise<AssistantCheckState | undefined> {
    const row = (
      await this.db.query('SELECT * FROM assistant_check_state WHERE agentId = ? AND runningKey = ?', [
        agentId,
        runningKey
      ])
    ).rows[0] as Row | undefined
    return row ? stateOf(row) : undefined
  }

  /** The agent's checks not yet settled, oldest first. */
  async running(agentId: string): Promise<AssistantCheckState[]> {
    const rows = (
      await this.db.query(
        'SELECT * FROM assistant_check_state WHERE agentId = ? AND runningKey IS NOT NULL ORDER BY updatedAt, itemId',
        [agentId]
      )
    ).rows as Row[]
    return rows.map(stateOf)
  }

  /** A check starts and takes any waiting messages; none while one runs, and with `exclusive` none while another of the agent's runs. */
  async begin(
    agentId: string,
    itemId: string,
    run: {
      key: string
      nextCheck: number | null
      observationVersion: number
      input: string | null
      now: number
      /** A check started before this no longer counts as running. */
      staleBefore: number
      exclusive: boolean
      /** What starts it unless messages wait, which always do: by default its time, else a message; `wake` starts only while a wake waits. */
      startedBy?: AssistantCheckStart
    }
  ): Promise<{ checkNo: number; messages: string | null; events: FollowUpEventKind[] } | undefined> {
    return await this.db.transaction(async (tx) => {
      await ensure(tx, agentId, itemId, run.now)
      const prior = stateOf(
        (await tx.query('SELECT * FROM assistant_check_state WHERE agentId = ? AND itemId = ?', [agentId, itemId]))
          .rows[0] as Row
      )
      const next = (
        await tx.query(
          'SELECT COALESCE(MAX(checkNo), 0) + 1 AS n FROM assistant_check WHERE agentId = ? AND itemId = ?',
          [agentId, itemId]
        )
      ).rows[0] as Row
      const checkNo = Number(next.n)
      const exclusive = run.exclusive
        ? ` AND NOT EXISTS (SELECT 1 FROM assistant_check_state o WHERE o.agentId = ? AND o.itemId <> ?
              AND o.runningKey IS NOT NULL AND o.runningSince >= ?)`
        : ''
      // Every check takes a waiting wake along (§5.14); one a wake starts also spaces the next woken one.
      const requested = run.startedBy ?? (run.nextCheck !== null ? 'time' : 'message')
      const woken = requested === 'wake'
      if (woken && prior.wakeAt === null) return undefined
      const { changes } = await tx.query(
        `UPDATE assistant_check_state SET runningKey = ?, runningNextCheck = ?, runningObservationVersion = ?,
           runningReport = NULL, runningCheck = ?, runningSince = ?, runningInput = ?, pendingMessages = NULL,
           runningWake = wakeKinds, wakeAt = NULL, wakeKinds = NULL, wakeLatestAt = NULL,
           lastWokenAt = ${woken ? '?' : 'lastWokenAt'},
           updatedAt = ?, failures = CASE WHEN stopped = 1 THEN 0 ELSE failures END, stopped = 0,
           stoppedNextCheck = NULL
         WHERE agentId = ? AND itemId = ? AND (runningKey IS NULL OR runningSince IS NULL OR runningSince < ?)${exclusive}`,
        [
          run.key,
          run.nextCheck,
          run.observationVersion,
          checkNo,
          run.now,
          run.input,
          ...(woken ? [run.now] : []),
          run.now,
          agentId,
          itemId,
          run.staleBefore,
          ...(run.exclusive ? [agentId, itemId, run.staleBefore] : [])
        ]
      )
      if (changes === 0) return undefined
      const startedBy: AssistantCheckStart = prior.pendingMessages !== null ? 'message' : requested
      // A stale check this one replaces ends in the log without having recorded anything.
      if (prior.runningCheck !== null)
        await tx.query(
          'UPDATE assistant_check SET endedAt = ? WHERE agentId = ? AND itemId = ? AND checkNo = ? AND endedAt IS NULL',
          [run.now, agentId, itemId, prior.runningCheck]
        )
      await tx.query(
        `INSERT INTO assistant_check (agentId, itemId, checkNo, startedAt, reported, startedBy, events)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [agentId, itemId, checkNo, run.now, startedBy, eventsText(prior.wakeKinds)]
      )
      // Pruning stops at the budget window, so the daily budget still sees every check it must count.
      await tx.query(
        'DELETE FROM assistant_check WHERE agentId = ? AND itemId = ? AND checkNo <= ? AND startedAt < ?',
        [agentId, itemId, checkNo - ASSISTANT_CHECKS_KEPT, run.now - CHECK_BUDGET_WINDOW_MS]
      )
      return { checkNo, messages: prior.pendingMessages, events: prior.wakeKinds }
    })
  }

  /** Put back the wake a check took that did not run to its end, in front of any that arrived meanwhile; it is due at once. */
  async restoreWake(agentId: string, itemId: string, events: readonly FollowUpEventKind[], now: number): Promise<void> {
    if (events.length === 0) return
    const state = await this.get(agentId, itemId)
    if (!state) return
    await this.db.query(
      `UPDATE assistant_check_state SET wakeAt = COALESCE(wakeAt, ?), wakeKinds = ?, wakeLatestAt = COALESCE(wakeLatestAt, ?),
         updatedAt = ? WHERE agentId = ? AND itemId = ?`,
      [now, eventsText(mergeEvents(events, state.wakeKinds)), now, now, agentId, itemId]
    )
  }

  /** Replace the messages waiting for the next check. */
  async setPendingMessages(agentId: string, itemId: string, messages: string | null, now: number): Promise<void> {
    await ensure(this.db, agentId, itemId, now)
    await this.db.query(
      'UPDATE assistant_check_state SET pendingMessages = ?, updatedAt = ? WHERE agentId = ? AND itemId = ?',
      [messages, now, agentId, itemId]
    )
  }

  /** Keep the running check's report for its end; false when that check is no longer the follow-up's. */
  async keepReport(agentId: string, itemId: string, key: string, text: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      'UPDATE assistant_check_state SET runningReport = ?, updatedAt = ? WHERE agentId = ? AND itemId = ? AND runningKey = ?',
      [text, now, agentId, itemId, key]
    )
    return changes > 0
  }

  /** Close a check's log row with what it saw, or why it failed, and whether its report got through. */
  async endCheck(
    agentId: string,
    itemId: string,
    checkNo: number,
    end: { observation: string | null; reported: boolean; now: number }
  ): Promise<void> {
    await this.db.query(
      `UPDATE assistant_check SET endedAt = ?, observation = ?, reported = ?
       WHERE agentId = ? AND itemId = ? AND checkNo = ?`,
      [end.now, end.observation, end.reported ? 1 : 0, agentId, itemId, checkNo]
    )
  }

  /** The check finished: a scheduled next check is done with and the streak is over. False when another check took the follow-up since. */
  async succeed(agentId: string, itemId: string, key: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_check_state SET checkedNextCheck = COALESCE(runningNextCheck, checkedNextCheck), failures = 0,
         retryAt = NULL, ${CLEAR_RUNNING}, updatedAt = ?
       WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [now, agentId, itemId, key]
    )
    return changes > 0
  }

  /** The check failed: back off, and stop at {@link CHECK_MAX_FAILURES}; undefined when another check took the follow-up since. */
  async fail(
    agentId: string,
    itemId: string,
    key: string,
    now: number,
    currentNextCheck: number | null
  ): Promise<{ failures: number; stopped: boolean } | undefined> {
    const state = await this.get(agentId, itemId)
    if (state?.runningKey !== key) return undefined
    const failures = state.failures + 1
    const stopped = failures >= CHECK_MAX_FAILURES
    const { changes } = await this.db.query(
      `UPDATE assistant_check_state SET failures = ?, retryAt = ?, stopped = ?, stoppedNextCheck = ?, ${CLEAR_RUNNING},
         updatedAt = ?
       WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [
        failures,
        now + checkBackoffMs(failures),
        stopped ? 1 : 0,
        stopped ? currentNextCheck : null,
        now,
        agentId,
        itemId,
        key
      ]
    )
    return changes > 0 ? { failures, stopped } : undefined
  }

  /** The check ended without counting either way (a pause, a shutdown): it leaves the log, and the same next check stays due. */
  async release(agentId: string, itemId: string, key: string, now: number): Promise<void> {
    const state = await this.get(agentId, itemId)
    if (state?.runningKey !== key) return
    const { changes } = await this.db.query(
      `UPDATE assistant_check_state SET ${CLEAR_RUNNING}, updatedAt = ? WHERE agentId = ? AND itemId = ? AND runningKey = ?`,
      [now, agentId, itemId, key]
    )
    if (changes > 0 && state.runningCheck !== null)
      await this.db.query('DELETE FROM assistant_check WHERE agentId = ? AND itemId = ? AND checkNo = ?', [
        agentId,
        itemId,
        state.runningCheck
      ])
  }

  /** This next check is passed over without a check, and is not tried again. */
  async skip(agentId: string, itemId: string, nextCheck: number, now: number): Promise<void> {
    await ensure(this.db, agentId, itemId, now)
    await this.db.query(
      'UPDATE assistant_check_state SET checkedNextCheck = ?, updatedAt = ? WHERE agentId = ? AND itemId = ?',
      [nextCheck, now, agentId, itemId]
    )
  }

  /** Grant up to `want` more history messages to a running check, at most `max` in all; how many it may read now. */
  async takeHistory(agentId: string, itemId: string, checkNo: number, want: number, max: number): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = (
        await this.db.query(
          'SELECT historyRead FROM assistant_check WHERE agentId = ? AND itemId = ? AND checkNo = ?',
          [agentId, itemId, checkNo]
        )
      ).rows[0] as Row | undefined
      if (!row) return 0
      const read = Number(row.historyRead)
      const granted = Math.max(0, Math.min(want, max - read))
      if (granted === 0) return 0
      const { changes } = await this.db.query(
        `UPDATE assistant_check SET historyRead = ? WHERE agentId = ? AND itemId = ? AND checkNo = ? AND historyRead = ?`,
        [read + granted, agentId, itemId, checkNo, read]
      )
      if (changes > 0) return granted
    }
    return 0
  }

  /** A follow-up's newest checks, newest first. */
  async checks(agentId: string, itemId: string, limit: number): Promise<AssistantCheck[]> {
    const rows = (
      await this.db.query(
        `SELECT itemId, checkNo, startedAt, endedAt, observation, reported, startedBy, events FROM assistant_check
          WHERE agentId = ? AND itemId = ? ORDER BY checkNo DESC LIMIT ?`,
        [agentId, itemId, limit]
      )
    ).rows as Row[]
    return rows.map((row) => ({
      itemId: String(row.itemId),
      checkNo: Number(row.checkNo),
      startedAt: Number(row.startedAt),
      endedAt: num(row.endedAt),
      observation: str(row.observation),
      reported: Number(row.reported) === 1,
      startedBy: ASSISTANT_CHECK_STARTS.find((start) => start === row.startedBy) ?? null,
      events: eventsOf(row.events)
    }))
  }

  /** How many checks the agent started since `since`, and when the oldest of them did, for its daily budget. */
  async checksSince(agentId: string, since: number): Promise<{ count: number; oldest: number | null }> {
    const row = (
      await this.db.query(
        'SELECT COUNT(*) AS n, MIN(startedAt) AS oldest FROM assistant_check WHERE agentId = ? AND startedAt >= ?',
        [agentId, since]
      )
    ).rows[0] as Row | undefined
    return { count: Number(row?.n ?? 0), oldest: num(row?.oldest) }
  }
}

async function ensure(
  db: Pick<AssistantCheckDatabase, 'query'>,
  agentId: string,
  itemId: string,
  now: number
): Promise<void> {
  await db.query(
    'INSERT OR IGNORE INTO assistant_check_state (agentId, itemId, failures, stopped, updatedAt) VALUES (?, ?, 0, 0, ?)',
    [agentId, itemId, now]
  )
}
