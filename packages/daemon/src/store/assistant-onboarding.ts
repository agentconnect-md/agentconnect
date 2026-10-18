// Each agent's onboarding conversation and organization research (assistant-mode.md §5.15), one row per agent, never removed.
import type { StoreQueryResult, StoreTx } from './store-database.js'

/** `greeting` until research opens in the onboarding DM, then `researching`; `skipped` when nobody could be reached. */
export type AssistantOnboardingState = 'greeting' | 'researching' | 'skipped'

/** The daemon's own round after the getting-to-know tasks that ran at onboarding: still `pending`, `sent`, or `none` to send. */
export type AssistantSecondRound = 'pending' | 'sent' | 'none'

export interface AssistantOnboardingRow {
  agentId: string
  /** The Control Plane's record of the switch-on this row answers, in epoch ms. */
  enabledAt: number
  state: AssistantOnboardingState
  /** The direct message research belongs to, and its long session; null on a skipped row. */
  platform: string | null
  channel: string | null
  transportScope: string | null
  integrationId: string | null
  parentKey: string | null
  parentThread: string | null
  parentSessionId: string | null
  /** The research task's session key, its `taskId`, minted before the hello names it. */
  taskKey: string | null
  /** Whom the hello addresses, and whether that is the person who switched the mode on. */
  person: string | null
  enabler: boolean
  /** The getting-to-know tasks running at onboarding, by follow-up id; research's second round waits on them. */
  gettingToKnowTasks: string[]
  secondRound: AssistantSecondRound
  /** Which attempt the second round's submission is; a definite refusal moves to the next, so a freed slot is tried again. */
  secondRoundAttempt: number
  reason: string | null
  createdAt: number
  updatedAt: number
}

export const ASSISTANT_ONBOARDING_SCHEMA = `
      CREATE TABLE IF NOT EXISTS assistant_onboarding (
        agentId TEXT PRIMARY KEY,
        enabledAt INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('greeting', 'researching', 'skipped')),
        platform TEXT,
        channel TEXT,
        transportScope TEXT,
        integrationId TEXT,
        parentKey TEXT,
        parentThread TEXT,
        parentSessionId TEXT,
        taskKey TEXT,
        person TEXT,
        enabler INTEGER NOT NULL DEFAULT 0,
        gettingToKnowTasks TEXT NOT NULL DEFAULT '[]',
        secondRound TEXT NOT NULL DEFAULT 'pending' CHECK (secondRound IN ('pending', 'sent', 'none')),
        secondRoundAttempt INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
`

type Row = Record<string, unknown>

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

function gettingToKnowTasksOf(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function rowOf(row: Row): AssistantOnboardingRow {
  return {
    agentId: String(row.agentId),
    enabledAt: Number(row.enabledAt),
    state: String(row.state) as AssistantOnboardingState,
    platform: text(row.platform),
    channel: text(row.channel),
    transportScope: text(row.transportScope),
    integrationId: text(row.integrationId),
    parentKey: text(row.parentKey),
    parentThread: text(row.parentThread),
    parentSessionId: text(row.parentSessionId),
    taskKey: text(row.taskKey),
    person: text(row.person),
    enabler: Number(row.enabler ?? 0) === 1,
    gettingToKnowTasks: gettingToKnowTasksOf(row.gettingToKnowTasks),
    secondRound: String(row.secondRound ?? 'pending') as AssistantSecondRound,
    secondRoundAttempt: Number(row.secondRoundAttempt ?? 0),
    reason: text(row.reason),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt)
  }
}

export interface AssistantOnboardingDatabase {
  query(sql: string, params: unknown[]): Promise<StoreQueryResult>
}

/** What a claimed onboarding names; the rest of the row starts at its defaults. */
export type AssistantOnboardingClaim = Pick<AssistantOnboardingRow, 'agentId' | 'enabledAt'> &
  Partial<
    Pick<
      AssistantOnboardingRow,
      | 'platform'
      | 'channel'
      | 'transportScope'
      | 'integrationId'
      | 'parentKey'
      | 'parentThread'
      | 'parentSessionId'
      | 'taskKey'
      | 'person'
      | 'enabler'
      | 'gettingToKnowTasks'
      | 'reason'
    >
  > & { state: 'greeting' | 'skipped'; now: number }

/** The onboarding row per agent: claimed once, so a repeated spec push or another member never greets twice. */
export class AssistantOnboardingLedger {
  constructor(private readonly db: AssistantOnboardingDatabase) {}

  async get(agentId: string): Promise<AssistantOnboardingRow | undefined> {
    const row = (await this.db.query('SELECT * FROM assistant_onboarding WHERE agentId = ?', [agentId])).rows[0] as
      Row | undefined
    return row ? rowOf(row) : undefined
  }

  /** Record this agent's onboarding; false when it already has one, whatever it says. */
  async claim(input: AssistantOnboardingClaim): Promise<boolean> {
    const { changes } = await this.db.query(
      `INSERT OR IGNORE INTO assistant_onboarding
         (agentId, enabledAt, state, platform, channel, transportScope, integrationId, parentKey, parentThread,
          parentSessionId, taskKey, person, enabler, gettingToKnowTasks, secondRound, reason, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.agentId,
        input.enabledAt,
        input.state,
        input.platform ?? null,
        input.channel ?? null,
        input.transportScope ?? null,
        input.integrationId ?? null,
        input.parentKey ?? null,
        input.parentThread ?? null,
        input.parentSessionId ?? null,
        input.taskKey ?? null,
        input.person ?? null,
        input.enabler ? 1 : 0,
        JSON.stringify(input.gettingToKnowTasks ?? []),
        input.state === 'skipped' ? 'none' : 'pending',
        input.reason ?? null,
        input.now,
        input.now
      ]
    )
    return changes > 0
  }

  /** The research task opened: `greeting` becomes `researching`, inside the task index's own transaction. */
  async markResearching(agentId: string, now: number, tx?: Pick<StoreTx, 'query'>): Promise<boolean> {
    const { changes } = await (tx ?? this.db).query(
      `UPDATE assistant_onboarding SET state = 'researching', updatedAt = ? WHERE agentId = ? AND state = 'greeting'`,
      [now, agentId]
    )
    return changes > 0
  }

  /** An agent that reads the record another agent researched has said hello: nothing is left for it to run. */
  async settleReader(agentId: string, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_onboarding SET state = 'skipped', secondRound = 'none', reason = ?, updatedAt = ?
        WHERE agentId = ? AND state = 'greeting'`,
      ['reads the organization record another agent researched', now, agentId]
    )
    return changes > 0
  }

  /** After a definite refusal, the next sweep's second round is a new submission, from `attempt` on. */
  async nextSecondRoundAttempt(agentId: string, attempt: number, now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_onboarding SET secondRoundAttempt = secondRoundAttempt + 1, updatedAt = ?
        WHERE agentId = ? AND secondRound = 'pending' AND secondRoundAttempt = ?`,
      [now, agentId, attempt]
    )
    return changes > 0
  }

  /** Settle the daemon's second round once, as sent or as none to send. */
  async settleSecondRound(agentId: string, outcome: 'sent' | 'none', now: number): Promise<boolean> {
    const { changes } = await this.db.query(
      `UPDATE assistant_onboarding SET secondRound = ?, updatedAt = ? WHERE agentId = ? AND secondRound = 'pending'`,
      [outcome, now, agentId]
    )
    return changes > 0
  }
}
