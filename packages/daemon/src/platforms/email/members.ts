// The member question (email-integration.md §4 step 3, §4.1): which addresses are members, which no member holds, asked of the Control Plane in one batch and cached briefly; fails closed.
import { EMAIL_MEMBERS_MAX, type AgentEmailMembersOk } from '@agentconnect.md/protocol'

/** How long an admitted address is reused before the Control Plane is asked again. */
export const EMAIL_MEMBER_ALLOW_TTL_MS = 120_000

/** How long a refusal is reused, so a new member or a widened visibility takes effect soon. */
export const EMAIL_MEMBER_DENY_TTL_MS = 30_000

/** Expired answers are dropped once this many are held. */
const SWEEP_AT = 1024

/** One address's answer: a member with their console user, or a refusal; `outsider` says the Control Plane answered that no member holds the address, and whether such a sender may open a session now. */
export type EmailMemberVerdict =
  { allowed: true; consoleUserId: string } | { allowed: false; outsider?: { admitted: boolean } }

export interface EmailMembersDeps {
  /** Ask the Control Plane about these addresses of one agent; undefined when it cannot be asked. */
  ask(agentId: string, addresses: string[]): Promise<AgentEmailMembersOk | undefined>
  now(): number
}

/** Whether the Control Plane answered that no member of the organization holds the address. */
export function isOutsider(verdict: EmailMemberVerdict | undefined): boolean {
  return verdict?.allowed === false && verdict.outsider !== undefined
}

/** Whether the address is outside the organization and may write to it now, under Anyone (§4.1). */
export function isAdmittedOutsider(verdict: EmailMemberVerdict | undefined): boolean {
  return verdict?.allowed === false && verdict.outsider?.admitted === true
}

export class EmailMembers {
  private readonly verdicts = new Map<string, { verdict: EmailMemberVerdict; expiresAt: number }>()

  constructor(private readonly deps: EmailMembersDeps) {}

  /** Every address's verdict, or undefined when an uncached one could not be asked: nothing is admitted on an unanswered question. */
  async judge(agentId: string, addresses: readonly string[]): Promise<Map<string, EmailMemberVerdict> | undefined> {
    const now = this.deps.now()
    const out = new Map<string, EmailMemberVerdict>()
    const unknown: string[] = []
    for (const address of new Set(addresses)) {
      const cached = this.verdicts.get(`${agentId}\x00${address}`)
      if (cached && cached.expiresAt > now) out.set(address, cached.verdict)
      else unknown.push(address)
    }
    for (let at = 0; at < unknown.length; at += EMAIL_MEMBERS_MAX) {
      const batch = unknown.slice(at, at + EMAIL_MEMBERS_MAX)
      let answer: AgentEmailMembersOk | undefined
      try {
        answer = await this.deps.ask(agentId, batch)
      } catch {
        answer = undefined
      }
      if (!answer) return undefined
      const admitted = new Map(answer.members.map((member) => [member.address, member.consoleUserId]))
      const outsiders = new Set(answer.outsiders ?? [])
      const outsidersAdmitted = answer.outsideSenders === 'admitted'
      if (this.verdicts.size >= SWEEP_AT) this.sweep()
      for (const address of batch) {
        // An address the answer leaves out is refused; one it names that was never asked about is ignored.
        const consoleUserId = admitted.get(address)
        const verdict: EmailMemberVerdict = consoleUserId
          ? { allowed: true, consoleUserId }
          : outsiders.has(address)
            ? { allowed: false, outsider: { admitted: outsidersAdmitted } }
            : { allowed: false }
        const reused = verdict.allowed || (verdict.outsider?.admitted ?? false)
        const ttl = reused ? EMAIL_MEMBER_ALLOW_TTL_MS : EMAIL_MEMBER_DENY_TTL_MS
        this.verdicts.set(`${agentId}\x00${address}`, { verdict, expiresAt: this.deps.now() + ttl })
        out.set(address, verdict)
      }
    }
    return out
  }

  /** The console user behind one admitted address, undefined for a refused one; rejects when it cannot be asked. */
  async consoleUser(agentId: string, address: string): Promise<string | undefined> {
    const verdict = (await this.judge(agentId, [address]))?.get(address)
    if (!verdict) throw new Error('the member question could not be asked')
    return verdict.allowed ? verdict.consoleUserId : undefined
  }

  private sweep(): void {
    const now = this.deps.now()
    for (const [key, entry] of this.verdicts) if (entry.expiresAt <= now) this.verdicts.delete(key)
  }

  /** Drop an agent's answers once its spec or integrations change. */
  forgetAgent(agentId: string): void {
    for (const key of this.verdicts.keys()) if (key.startsWith(`${agentId}\x00`)) this.verdicts.delete(key)
  }
}
