/** CP platform integrations live only in daemon memory and are re-converged on reconnect. */
import type { IntegrationSpec } from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import { toIntegration, type WriteIntegrationDeps } from '../agents/write-integration.js'

interface Entry {
  agentId: string
  integration: Integration
}

export class CpIntegrationRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(
    _agentsDir: string,
    private readonly deps: WriteIntegrationDeps,
    private readonly onChange: () => void
  ) {}

  upsert(spec: IntegrationSpec): void {
    const integration = toIntegration(spec)
    if (!integration) {
      this.deps.warn?.(`cp: integration ${spec.integrationId} carried no usable platform payload — ignored`)
      return
    }
    this.entries.set(spec.integrationId, { agentId: spec.agentId, integration })
    this.onChange()
  }

  remove(integrationId: string): void {
    if (this.entries.delete(integrationId)) this.onChange()
  }

  converge(specs: IntegrationSpec[]): void {
    for (const spec of specs ?? []) {
      const integration = toIntegration(spec)
      if (integration) this.entries.set(spec.integrationId, { agentId: spec.agentId, integration })
      else this.deps.warn?.(`cp: integration ${spec.integrationId} carried no usable platform payload — ignored`)
    }
    this.onChange()
  }

  forAgent(agentId: string): Integration[] {
    return [...this.entries.values()].filter((entry) => entry.agentId === agentId).map((entry) => entry.integration)
  }

  retainForAgent(agentId: string, desiredIds: ReadonlySet<string>): boolean {
    let changed = false
    for (const [id, entry] of this.entries) {
      if (entry.agentId === agentId && !desiredIds.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.onChange()
    return changed
  }
}
