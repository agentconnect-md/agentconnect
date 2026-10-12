import type { ChatActorVerdict } from './chat-actions.js'

/** How long an editor's verdict is reused: the control plane's own linked-identity lease. */
export const CHAT_ACTOR_ALLOW_TTL_MS = 120_000

/** How long a refusal is reused, so a link or a promotion takes effect soon. */
export const CHAT_ACTOR_DENY_TTL_MS = 30_000

/** Expired verdicts are dropped once this many are held. */
const SWEEP_AT = 512

/** The control plane's answer for one chat member: an editor's linked identity, and when refused whether they are linked at all. */
export type ChatActorAnswer = { allowed: boolean; linked?: boolean }

export interface ChatActorDeps {
  /** Ask the control plane; undefined when it cannot be asked (offline, or one without `chat-actor-v1`). */
  ask(agentId: string, integrationId: string, userId: string): Promise<ChatActorAnswer | undefined>
  now(): number
}

/** Whether a chat member is one of the agent's editors on a synced integration, asked of the control plane and cached briefly; fails closed. */
export class ChatActors {
  private readonly verdicts = new Map<string, { verdict: ChatActorVerdict; expiresAt: number }>()

  constructor(private readonly deps: ChatActorDeps) {}

  async judge(agentId: string, integrationId: string, userId: string): Promise<ChatActorVerdict> {
    const key = `${agentId}\x00${integrationId}\x00${userId}`
    const cached = this.verdicts.get(key)
    if (cached && cached.expiresAt > this.deps.now()) return cached.verdict
    let answer: ChatActorAnswer | undefined
    try {
      answer = await this.deps.ask(agentId, integrationId, userId)
    } catch {
      answer = undefined
    }
    // An unanswered question is refused and asked again next time.
    if (!answer) return 'unavailable'
    const verdict: ChatActorVerdict = answer.allowed ? 'allowed' : answer.linked === false ? 'unlinked' : 'not-editor'
    const ttl = verdict === 'allowed' ? CHAT_ACTOR_ALLOW_TTL_MS : CHAT_ACTOR_DENY_TTL_MS
    if (this.verdicts.size >= SWEEP_AT) this.sweep()
    this.verdicts.set(key, { verdict, expiresAt: this.deps.now() + ttl })
    return verdict
  }

  private sweep(): void {
    const now = this.deps.now()
    for (const [key, entry] of this.verdicts) if (entry.expiresAt <= now) this.verdicts.delete(key)
  }

  /** Drop an agent's verdicts once its spec or integrations change. */
  forgetAgent(agentId: string): void {
    for (const key of this.verdicts.keys()) if (key.startsWith(`${agentId}\x00`)) this.verdicts.delete(key)
  }
}
