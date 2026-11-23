// Admitting a new session with the control plane under its organization's session policy (org-session-policy.md, Enforcement).
import { SESSION_LIMIT_REACHED, type SessionAdmitRequest } from '@agentconnect.md/protocol'

/** Why a new session may not start now; the user-visible wording is `sessionAdmissionMessage`. */
export const SESSION_QUOTA_UNAVAILABLE = 'session_quota_unavailable'

/** One `session/admit` answer as the client read it. */
export type SessionAdmitOutcome =
  | { kind: 'admitted'; enforcing?: boolean }
  | { kind: 'refused'; limit: number; used: number; resetsAt: string }
  | { kind: 'unsupported' }
  | { kind: 'failed' }

/** The control-plane end of an admission; `wait` holds the request within its deadline budget across a reconnect. */
export interface SessionAdmitPort {
  /** Whether a request would go out now: a live link to a control plane that admits sessions. */
  admitsSessions?(): boolean
  admitSession?(
    agentId: string,
    sessionId: string,
    purpose?: SessionAdmitRequest['purpose'],
    opts?: { wait?: boolean }
  ): Promise<SessionAdmitOutcome>
}

/** Whether a new session may start: refused at the limit, or while its enforcing organization cannot be asked. */
export type SessionAdmissionVerdict =
  | { admitted: true }
  | { admitted: false; reason: typeof SESSION_LIMIT_REACHED; limit: number; used: number; resetsAt: string }
  | { admitted: false; reason: typeof SESSION_QUOTA_UNAVAILABLE }

export type SessionAdmissionRefusal = Extract<SessionAdmissionVerdict, { admitted: false }>

export interface SessionAdmissionGateDeps {
  cp: () => SessionAdmitPort | undefined
  /** The agent's organization, the key the last enforcement answer is remembered under. */
  orgFor: (agentId: string) => string | undefined
  log: { warn: (message: string) => void; info: (message: string) => void }
}

/** Remembers each organization's last answered enforcement, in memory, and turns an answer into a verdict. */
export class SessionAdmissionGate {
  private readonly enforcing = new Map<string, boolean>()

  constructor(private readonly deps: SessionAdmissionGateDeps) {}

  /** The last answer for the agent's organization; false before any, as a control plane that predates enforcement answers. */
  enforces(agentId: string): boolean {
    return this.enforcing.get(this.orgKey(agentId)) === true
  }

  /** Admit `sessionId`: wait for the answer only while the organization last enforced, and fail open otherwise. */
  async admit(
    agentId: string,
    sessionId: string,
    purpose?: SessionAdmitRequest['purpose']
  ): Promise<SessionAdmissionVerdict> {
    const org = this.orgKey(agentId)
    const enforcing = this.enforcing.get(org) === true
    const cp = this.deps.cp()
    // Not enforcing, a link that is down or a control plane that does not admit is today's silent fail-open.
    if (!cp?.admitSession || (!enforcing && !cp.admitsSessions?.())) return { admitted: true }
    let outcome: SessionAdmitOutcome
    let thrown = ''
    try {
      // An answer of no known kind is read as no answer.
      outcome = (await cp.admitSession(agentId, sessionId, purpose, { wait: enforcing })) ?? { kind: 'failed' }
    } catch (err) {
      thrown = ` (${err instanceof Error ? err.message : 'unknown error'})`
      outcome = { kind: 'failed' }
    }
    switch (outcome.kind) {
      case 'admitted':
        this.enforcing.set(org, outcome.enforcing === true)
        return { admitted: true }
      case 'refused':
        this.enforcing.set(org, true)
        this.deps.log.info(
          `session admission for ${sessionId} refused: ${outcome.used}/${outcome.limit} sessions this month`
        )
        return {
          admitted: false,
          reason: SESSION_LIMIT_REACHED,
          limit: outcome.limit,
          used: outcome.used,
          resetsAt: outcome.resetsAt
        }
      case 'unsupported':
        // A control plane that does not admit sessions enforces nothing.
        this.enforcing.delete(org)
        return { admitted: true }
      case 'failed':
        if (enforcing) {
          this.deps.log.warn(
            `session admission for ${sessionId} got no answer while its organization enforces${thrown}`
          )
          return { admitted: false, reason: SESSION_QUOTA_UNAVAILABLE }
        }
        this.deps.log.warn(`session admission for ${sessionId} failed${thrown}; starting the session anyway`)
        return { admitted: true }
    }
  }

  private orgKey(agentId: string): string {
    return this.deps.orgFor(agentId) ?? ''
  }
}

/** A refused new session, carried as the turn's failure so each entry reports it through its own result. */
export class SessionAdmissionRefusedError extends Error {
  constructor(readonly refusal: SessionAdmissionRefusal) {
    super(sessionAdmissionMessage(refusal))
    this.name = 'SessionAdmissionRefusedError'
  }

  get reason(): SessionAdmissionRefusal['reason'] {
    return this.refusal.reason
  }
}

/** The person-facing wording of a refusal, naming the count, the limit and when the month resets. */
export function sessionAdmissionMessage(refusal: SessionAdmissionRefusal): string {
  if (refusal.reason === SESSION_QUOTA_UNAVAILABLE) {
    return "A new session can't start right now because this organization's monthly session usage can't be checked. Try again in a moment; existing sessions are not affected."
  }
  return `This organization has used ${refusal.used} of its ${refusal.limit} sessions this month, so a new session can't start. The count resets ${formatReset(refusal.resetsAt)}; existing sessions can still continue.`
}

function formatReset(resetsAt: string): string {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return 'at the start of next month'
  return `on ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}
