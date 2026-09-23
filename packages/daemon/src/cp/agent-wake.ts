// `AgentWaker` — the daemon side of the console's `agent/wake`: claim the duty if needed, then bring ONE pod to Running and bind its channel, with no host or ACP session; it answers what it OBSERVED.
import type { AgentWakeOk, AgentWakeReq } from '@agentconnect.md/protocol'
import { agentSandboxSubject } from '../remote/sandbox-subject.js'

export interface AgentWakerDeps {
  /** The sandbox plane; undefined on a daemon that runs no sandboxes, where every wake is `unsupported`. */
  sandbox?: {
    /** Is this pod's channel bound right now — the condition the file reader serves on? */
    isRunning: (subject: string) => boolean
    /** Bring the agent's own pod up and bind its channel WITHOUT starting a runtime, claiming it as a turn would. */
    ensureChannel: (subject: string) => Promise<void>
    /** The pod one session's workspace lives on (its own for an isolated session), or undefined when it has none here. */
    sessionPod: (agentId: string, sessionId: string) => Promise<string | undefined>
    /** The uid of the claim the cluster holds for a pod, or undefined when it holds none. */
    claimUidFor: (subject: string) => Promise<string | undefined>
    /** Resume a pod onto the claim just observed and bind its channel, creating nothing. */
    resumeChannel: (subject: string, claimUid: string) => Promise<void>
  }
  /** Is the agent installed here? A wake for an agent this member does not serve is refused, not guessed at. */
  knowsAgent: (agentId: string) => boolean
  /** Take the agent's duty when it is not held here (the activation rendezvous); undefined ⇒ duty is not enforced. */
  claimDuty?: (agentId: string) => Promise<boolean>
  log: { warn(msg: string): void }
}

/** Refused wake: the agent is not this member's to wake, or the session's own sandbox is gone and no wake may recreate it. */
export class AgentWakeViolationError extends Error {
  constructor(
    message: string,
    readonly reason: 'unknown-agent' | 'sandbox-removed'
  ) {
    super(message)
    this.name = 'AgentWakeViolationError'
  }
}

export interface AgentWaker {
  wake(req: AgentWakeReq): Promise<AgentWakeOk>
}

export function createAgentWaker(deps: AgentWakerDeps): AgentWaker {
  // One bind per pod at a time: a burst of wakes costs one resume.
  const inflight = new Map<string, Promise<void>>()

  function startBind(subject: string, bind: () => Promise<void>): void {
    if (inflight.has(subject)) return
    const run = bind()
      .catch((err: unknown) => deps.log.warn(`wake: sandbox "${subject}" did not come up: ${(err as Error).message}`))
      .finally(() => inflight.delete(subject))
    inflight.set(subject, run)
  }

  return {
    async wake(req) {
      const { agentId, sessionId } = req
      const sandbox = deps.sandbox
      if (!sandbox) return { agentId, state: 'unsupported' }
      if (!deps.knowsAgent(agentId)) {
        // Claim on receipt like a relay trigger: install, then hold, then answer.
        const claimed = deps.claimDuty ? await deps.claimDuty(agentId) : false
        if (!claimed || !deps.knowsAgent(agentId)) {
          throw new AgentWakeViolationError(`unknown agent "${agentId}"`, 'unknown-agent')
        }
      }
      const agentPod = agentSandboxSubject(agentId)
      const subject = sessionId === undefined ? agentPod : await sandbox.sessionPod(agentId, sessionId)
      if (subject === undefined) {
        throw new AgentWakeViolationError(`agent "${agentId}" has no workspace for that session`, 'unknown-agent')
      }
      if (sandbox.isRunning(subject)) return { agentId, state: 'running' }
      if (inflight.has(subject)) return { agentId, state: 'starting' }
      if (subject === agentPod) {
        startBind(subject, () => sandbox.ensureChannel(subject))
        return { agentId, state: 'starting' }
      }
      // A session's pod is only resumed, onto the claim observed here: that claim IS its volume, and an ensure would make an empty one.
      const claimUid = await sandbox.claimUidFor(subject)
      if (claimUid === undefined) {
        throw new AgentWakeViolationError(
          `the sandbox of that session of agent "${agentId}" was removed`,
          'sandbox-removed'
        )
      }
      startBind(subject, () => sandbox.resumeChannel(subject, claimUid))
      return { agentId, state: 'starting' }
    }
  }
}
