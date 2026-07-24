/**
 * `CpIntegrationRegistry` — applies CP-owned platform integrations onto the
 * daemon's on-disk `agent.json` files, which are the SINGLE SOURCE OF TRUTH
 * (same model as CpAgentRegistry). The CP pushes deltas over
 * `integration/upsert` / `integration/remove` and the full per-daemon set over
 * the `register/ok` reconcile roster; this writes each straight to the owning
 * agent's `integrations[]` (upsert by integrationId). Nothing is held in memory,
 * so integrations — and their Slack tokens — survive a daemon restart with the
 * CP down: `daemon.start()` opens Socket Mode connections from disk alone.
 *
 * Tokens on disk share the daemon's trust boundary (hand-authored agents already
 * keep Slack tokens in agent.json). They still MUST NEVER be logged.
 *
 * `converge` upserts every roster entry. Reconnect pruning is explicit through
 * `register/ok.drop.integrations`, after ownership-aware CP reconciliation.
 *
 * Every mutation fires `onChange` so the daemon re-reconciles (re-loads agents
 * from disk; diffAgents flags the `integrations` dimension, which re-opens/binds
 * the Slack sockets).
 */
import type { IntegrationSpec } from '@agentconnect.md/protocol'
import { writeIntegrationSpec, removeIntegration, type WriteIntegrationDeps } from '../agents/write-integration.js'

export class CpIntegrationRegistry {
  constructor(
    private readonly agentsDir: string,
    private readonly deps: WriteIntegrationDeps,
    private readonly onChange: () => void
  ) {}

  /** Add or replace one integration on the owning agent's disk file (integration/upsert EVT). */
  upsert(spec: IntegrationSpec): void {
    writeIntegrationSpec(this.agentsDir, spec, this.deps)
    this.onChange()
  }

  /** Splice one integration out of whichever agent.json holds it (integration/remove EVT). */
  remove(integrationId: string): void {
    removeIntegration(this.agentsDir, integrationId)
    this.onChange()
  }

  /**
   * Apply the register/ok reconcile roster: upsert EACH entry and NOTHING else.
   * The caller applies the separately-authorized drop list first; roster
   * absence alone is never enough to prune a hand-authored local integration.
   */
  converge(specs: IntegrationSpec[]): void {
    // Tolerate a snapshot without the field (older CP / hand-built) — treat as empty.
    for (const spec of specs ?? []) {
      writeIntegrationSpec(this.agentsDir, spec, this.deps)
    }
    this.onChange()
  }
}
