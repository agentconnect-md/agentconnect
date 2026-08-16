/**
 * Managed distillation as a durable capture: the post-turn distillation of a cluster agent needs its
 * sandbox (the memory tree lives on the volume, and the extraction runs on the warm host in the pod).
 * When the turn's capture arrives after the pod was suspended, the turn is enqueued in the memory
 * capture outbox — the same durable, shared-store-safe pump external plugins use — under a synthetic
 * per-agent connection, and drained once the sandbox is bound again on the member holding the agent.
 *
 * The outbox knows nothing new: this module presents one "connection" per agent through the same
 * registry contract, answering no client while the tree is unreachable (the pump then defers the row
 * without spending an attempt) and a client that runs the distillation once it is.
 */
import type { CaptureReceipt, MemoryPluginCaptureInput } from '@agentconnect.md/protocol'
import type { EnqueueMemoryCapture, MemoryCaptureClient, MemoryCapturePumpRegistry } from '../memory-plugin/outbox.js'

export const MANAGED_DISTILL_PLUGIN_ID = 'agentconnect.managed-distill'
const CONNECTION_PREFIX = 'managed-distill:'
/** The synthetic connection has one immutable definition, so a row can never mismatch it. */
const CONNECTION_REVISION = 1

export function managedDistillConnectionId(agentId: string): string {
  return `${CONNECTION_PREFIX}${agentId}`
}

function managedDistillAgentId(connectionId: string): string | undefined {
  return connectionId.startsWith(CONNECTION_PREFIX) ? connectionId.slice(CONNECTION_PREFIX.length) : undefined
}

/** The row for one deferred turn; the outbox bounds the texts and derives the operation id. */
export function managedDistillCapture(input: {
  agentId: string
  turnId: string
  sessionId?: string
  input: string
  output: string
}): EnqueueMemoryCapture {
  return {
    agentId: input.agentId,
    connectionId: managedDistillConnectionId(input.agentId),
    connectionRevision: CONNECTION_REVISION,
    pluginId: MANAGED_DISTILL_PLUGIN_ID,
    config: {},
    idempotency: 'operation-id',
    turnId: input.turnId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    input: input.input,
    output: input.output
  }
}

export interface ManagedDistillDeps {
  /** Agents whose deferred distillations this member may drain: held here, managed memory. */
  agentIds(): readonly string[]
  /** Whether the agent's memory tree is reachable right now (its sandbox is bound, or it is local). */
  reachable(agentId: string): boolean
  /** Run the distillation for one turn against the live tree; throws when it cannot. */
  distill(agentId: string, turn: MemoryPluginCaptureInput['turn']): Promise<void>
}

/** The registry the outbox pumps: every plugin connection of `base`, plus one managed connection per agent. */
export function withManagedDistill(
  base: MemoryCapturePumpRegistry,
  deps: ManagedDistillDeps
): MemoryCapturePumpRegistry {
  const clientFor = (agentId: string): MemoryCaptureClient => ({
    manifest: { plugin: { id: MANAGED_DISTILL_PLUGIN_ID }, capabilities: { idempotency: 'operation-id' } },
    async capture(input): Promise<CaptureReceipt> {
      await deps.distill(agentId, input.turn)
      return { state: 'completed' }
    },
    // A managed capture never answers `accepted`, so there is no status to poll.
    async operationStatus(): Promise<CaptureReceipt> {
      return { state: 'completed' }
    }
  })
  return {
    connectionIds: () => [...base.connectionIds(), ...deps.agentIds().map(managedDistillConnectionId)],
    clientFor: (connectionId) => {
      const agentId = managedDistillAgentId(connectionId)
      if (agentId === undefined) return base.clientFor(connectionId)
      // No client while the tree is unreachable: the pump defers the row without spending an attempt.
      return deps.reachable(agentId) ? clientFor(agentId) : undefined
    },
    specFor: (connectionId) =>
      managedDistillAgentId(connectionId) === undefined
        ? base.specFor(connectionId)
        : { revision: CONNECTION_REVISION },
    markDegraded: (connectionId, reasonCode) => {
      if (managedDistillAgentId(connectionId) === undefined) base.markDegraded(connectionId, reasonCode)
    },
    markRecovered: (connectionId, reasonCodes) => {
      if (managedDistillAgentId(connectionId) === undefined) base.markRecovered(connectionId, reasonCodes)
    }
  }
}
