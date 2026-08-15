// Duty-ledger domain types (k8s daemons): the claim unit is a GROUP — a
// connected component of the agent↔daemon-held-bot graph — never a single row.
// Shared by the pure planner (orchestrator/dutyGroup.ts) and the repo port.

export type DutyMemberKind = 'agent' | 'bot'

/** An active Integration row whose bot the daemon itself connects (socket transport).
 *  An edge only forces CO-LOCATION; it is not what makes an agent ownable. */
export interface DutyEdge {
  agentId: string
  botId: string
}

/** Every agent is ownable: it seeds at least a singleton, with or without edges. */
export interface AgentSeed {
  agentId: string
}

export interface DutyMemberKey {
  kind: DutyMemberKind
  refId: string
}

export interface DutyGroupWrite {
  groupId: string
  members: DutyMemberKey[]
  /** Non-null ⇒ the group is held and composition changed: re-grant to this holder at a bumped term. */
  regrantTo: string | null
}

export interface DutyGroupCreate {
  members: DutyMemberKey[]
  /** Non-null ⇒ a pure split remainder of one held group: grant to that holder (no eviction). */
  grantTo: string | null
}

export interface DutySupersession {
  groupId: string
  holder: string
}

/** The deterministic recompute output the repo applies transactionally. */
export interface DutyReconcilePlan {
  /** Groups whose composition is unchanged — no write at all. */
  unchanged: string[]
  writes: DutyGroupWrite[]
  creates: DutyGroupCreate[]
  /** Groups whose identity did not survive the recompute. */
  deletes: string[]
  /** Held groups whose members now live under a different holder (or nowhere): notify + teardown. */
  superseded: DutySupersession[]
}
