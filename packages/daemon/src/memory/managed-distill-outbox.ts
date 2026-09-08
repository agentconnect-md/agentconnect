// Managed distillation as a durable capture: a post-turn distillation needs the agent's memory home — the sandbox volume
// (and the warm host in the pod), or the Control Plane for a `control-plane` tree. A turn captured while the home is out
// of reach is enqueued in the memory capture outbox — the same durable, shared-store-safe pump external plugins use —
// under a synthetic per-agent connection, and drained once the home is reachable again on the member holding the agent.
// The outbox knows nothing new: one "connection" per agent through the same registry contract, answering no client while
// the home is unreachable (the pump then defers the row without spending an attempt) and a distilling one once it is.
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
  /** Whether the agent's memory home is reachable right now: this disk always, a sandbox volume while the pod is bound, a `control-plane` tree while the CP is READY with the feature and no migration copy pending. */
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
