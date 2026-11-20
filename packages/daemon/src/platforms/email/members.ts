// The member question (email-integration.md §4 step 3): which addresses are members who may write to an agent, asked of the Control Plane in one batch and cached briefly; fails closed.
import { EMAIL_MEMBERS_MAX, type EmailMember } from '@agentconnect.md/protocol'

/** How long an admitted address is reused before the Control Plane is asked again. */
export const EMAIL_MEMBER_ALLOW_TTL_MS = 120_000

/** How long a refusal is reused, so a new member or a widened visibility takes effect soon. */
export const EMAIL_MEMBER_DENY_TTL_MS = 30_000

/** Expired answers are dropped once this many are held. */
const SWEEP_AT = 1024

/** One address's answer: the console user it is the verified sign-in email of, or a refusal that never says why. */
export type EmailMemberVerdict = { allowed: true; consoleUserId: string } | { allowed: false }

export interface EmailMembersDeps {
  /** Ask the Control Plane about these addresses of one agent; undefined when it cannot be asked. */
  ask(agentId: string, addresses: string[]): Promise<readonly EmailMember[] | undefined>
  now(): number
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
      let members: readonly EmailMember[] | undefined
      try {
        members = await this.deps.ask(agentId, batch)
      } catch {
        members = undefined
      }
      if (!members) return undefined
      const admitted = new Map(members.map((member) => [member.address, member.consoleUserId]))
      if (this.verdicts.size >= SWEEP_AT) this.sweep()
      for (const address of batch) {
        // An address the answer leaves out is refused; one it names that was never asked about is ignored.
        const consoleUserId = admitted.get(address)
        const verdict: EmailMemberVerdict = consoleUserId ? { allowed: true, consoleUserId } : { allowed: false }
        const ttl = verdict.allowed ? EMAIL_MEMBER_ALLOW_TTL_MS : EMAIL_MEMBER_DENY_TTL_MS
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
