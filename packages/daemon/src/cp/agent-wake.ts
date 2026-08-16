// `AgentWaker` — the daemon side of the console's `agent/wake`: claim the duty if needed, then bring the
// sandbox to Running and bind its channel — the first half of a turn, deliberately without the second
// (no host, no ACP session). It answers what it OBSERVED, never a promise; the console polls the read.
import type { AgentWakeOk, AgentWakeReq } from '@agentconnect.md/protocol'

export interface AgentWakerDeps {
  /** The sandbox plane; undefined on a daemon that runs no sandboxes, where every wake is `unsupported`. */
  sandbox?: {
    /** Is the agent's sandbox channel bound right now — the condition the file reader serves on? */
    isRunning: (agentId: string) => boolean
    /** Bring the sandbox up and bind its channel WITHOUT starting a runtime. */
    ensureChannel: (agentId: string) => Promise<void>
  }
  /** Is the agent installed here? A wake for an agent this member does not serve is refused, not guessed at. */
  knowsAgent: (agentId: string) => boolean
  /** Take the agent's duty when it is not held here (the activation rendezvous); undefined ⇒ duty is not enforced. */
  claimDuty?: (agentId: string) => Promise<boolean>
  log: { warn(msg: string): void }
}

/** Refused wake: the agent is not, and could not become, this member's to wake. */
export class AgentWakeViolationError extends Error {
  constructor(
    message: string,
    readonly reason: 'unknown-agent'
  ) {
    super(message)
    this.name = 'AgentWakeViolationError'
  }
}

export interface AgentWaker {
  wake(req: AgentWakeReq): Promise<AgentWakeOk>
}

export function createAgentWaker(deps: AgentWakerDeps): AgentWaker {
  // One bind per agent at a time: a burst of wakes costs one resume.
  const inflight = new Map<string, Promise<void>>()

  function startBind(agentId: string, sandbox: NonNullable<AgentWakerDeps['sandbox']>): Promise<void> {
    const existing = inflight.get(agentId)
    if (existing) return existing
    const bind = sandbox
      .ensureChannel(agentId)
      .catch((err: unknown) =>
        deps.log.warn(`wake: sandbox for agent "${agentId}" did not come up: ${(err as Error).message}`)
      )
      .finally(() => inflight.delete(agentId))
    inflight.set(agentId, bind)
    return bind
  }

  return {
    async wake(req) {
      const { agentId } = req
      if (!deps.sandbox) return { agentId, state: 'unsupported' }
      if (!deps.knowsAgent(agentId)) {
        // Claim on receipt like a relay trigger: install, then hold, then answer.
        const claimed = deps.claimDuty ? await deps.claimDuty(agentId) : false
        if (!claimed || !deps.knowsAgent(agentId)) {
          throw new AgentWakeViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
        }
      }
      if (deps.sandbox.isRunning(agentId)) return { agentId, state: 'running' }
      void startBind(agentId, deps.sandbox)
      return { agentId, state: 'starting' }
    }
  }
}
