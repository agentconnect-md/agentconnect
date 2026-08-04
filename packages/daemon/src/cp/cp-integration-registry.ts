/**
 * CP platform integrations live only in daemon memory and are re-converged on
 * reconnect (register/ok roster + integration/upsert live pushes).
 *
 * SECURITY: specs carry PLAINTEXT platform tokens. Never log a spec or an
 * entry — ids only.
 */
import type { IntegrationSpec } from '@agentconnect.md/protocol'
import type { Integration } from '../agents/agent-schema.js'
import { integrationConfig } from '../platforms/integration-config.js'

export interface WriteIntegrationDeps {
  /** Warn sink for a spec that cannot be applied (unknown platform / bad payload). */
  warn?: (msg: string) => void
}

/**
 * Map the wire {@link IntegrationSpec} to the daemon's {@link Integration}
 * shape — since the S3 flatten the two ARE the same envelope (§6.4), so this
 * is a rename plus the fail-closed ingest gate: the opaque `config` must
 * validate against the platform module's own schema, resolved through the
 * registry (`platforms/integration-config.ts`). Returns null — reader-side
 * rejection, the frame stays healthy — for an unregistered platform id or a
 * payload the module schema refuses; the caller warns and skips, and the CP
 * re-sends on the next push/reconcile.
 *
 * One cross-field rule from the retired wire refine survives here, at the same
 * seam it used to guard: a DIRECT (socket) Slack spec without an app-level
 * token can never open its connection, so the SPEC is refused loudly rather
 * than stored half-alive. (A hand-authored disk entry is deliberately not
 * subject to this — see `integrationConfig` — matching pre-flatten behavior.)
 */
export function toIntegration(spec: IntegrationSpec): Integration | null {
  const integration: Integration = {
    id: spec.integrationId,
    origin: 'cp',
    platform: spec.platform,
    core: spec.core,
    ...(spec.config !== undefined ? { config: spec.config } : {})
  }
  const config = integrationConfig(integration)
  if (!config) return null
  if (spec.platform === 'slack' && spec.core.mode === 'direct' && !('appToken' in config && config.appToken)) {
    return null
  }
  return integration
}

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
