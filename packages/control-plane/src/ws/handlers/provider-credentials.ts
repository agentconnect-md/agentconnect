import {
  AgentModelKeyProvider,
  DECISION_PROVIDER_PROFILES,
  isFrame,
  ProviderKeyProvider,
  REPLY_BUDGET
} from '@agentconnect.md/protocol'
import { AgentId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { AgentRecord } from '../../persistence/ports.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

// A Decision Try borrows any placed agent for a member's draft, so every agent may evaluate with a Decision provider.
const DECISION_KEY_PROVIDERS = DECISION_PROVIDER_PROFILES.flatMap((profile) => {
  const provider = ProviderKeyProvider.safeParse(profile.id)
  return provider.success ? [provider.data] : []
})

/** The organization provider keys an agent's daemon may read: its model provider (`auto` resolves on the daemon) and the Decision providers. */
export function agentProviderKeys(agent: Pick<AgentRecord, 'modelProvider'>): ReadonlySet<ProviderKeyProvider> {
  const model = !agent.modelProvider
    ? []
    : agent.modelProvider === 'auto'
      ? AgentModelKeyProvider.options
      : [agent.modelProvider]
  return new Set([...model, ...DECISION_KEY_PROVIDERS])
}

export const handleProviderCredentials: Handler = async (frame, conn, deps) => {
  if (!isFrame('provider-credentials/request')(frame)) return
  const orgId = frameOrgId(frame, conn)
  if (!orgId || !deps.providerKey) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'provider credentials are unavailable for this organization', false)
    return
  }
  const { agentId, provider } = frame.payload
  const scope = async (): Promise<'served' | 'unserved' | 'unused'> => {
    const agent = await deps.agent.get(orgId, AgentId(agentId))
    if (!agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, conn.daemonId))) return 'unserved'
    return agentProviderKeys(agent).has(provider) ? 'served' : 'unused'
  }
  const before = await scope()
  if (before !== 'served') {
    const message =
      before === 'unserved' ? 'this daemon does not serve that agent' : 'that agent does not use this provider'
    conn.sendError(frame.id, 'SCOPE_DENIED', message, false)
    return
  }
  try {
    const credentials = await deps.providerKey.get(orgId, provider)
    const after = await scope()
    if (after !== 'served') {
      const message =
        after === 'unserved' ? 'this daemon no longer serves that agent' : 'that agent no longer uses this provider'
      conn.sendError(frame.id, 'SCOPE_DENIED', message, false)
      return
    }
    if (Buffer.byteLength(JSON.stringify({ credentials }), 'utf8') > REPLY_BUDGET) {
      conn.sendError(frame.id, 'LEASE_DENIED', 'provider configuration exceeds the credential delivery limit', false)
      return
    }
    conn.replyTo(frame, 'provider-credentials/reply', { credentials })
  } catch {
    // Cipher errors may contain secret values; return only a stable failure classification.
    conn.sendError(frame.id, 'INTERNAL', 'provider credentials could not be read', true)
  }
}
