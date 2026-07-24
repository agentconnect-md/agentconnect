/**
 * CP runtime env. The Control Plane owns the editable agent spec (prompt, model,
 * reasoning/execution knobs, env, workspace) and ships it over `agent/upsert` +
 * the `register/ok` reconcile roster. As of the agent.json-is-authoritative
 * change, those specs are written straight to disk (see agents/write-agent.ts),
 * so there is no in-memory overlay — the daemon reads the on-disk `agent.json`.
 *
 * What remains here is the mapping from an agent's fields to the `AGENTCONNECT_*`
 * environment the daemon surfaces to the ACP child.
 */
import type { Agent } from './agent-schema.js'

/**
 * Runtime config surfaced to the ACP child as environment variables, under
 * `AGENTCONNECT_*` for runtimes that read them. ACP `session/new`/`initialize`
 * carry no model / effort field (SDK v1); model + reasoning effort are
 * additionally applied per session via ACP session config options
 * (`session/set_config_option`) when the runtime advertises the selectors —
 * see AcpHost.applySessionConfig — which is how claude-acp actually honors
 * them. The env stays the fallback for runtimes without config options.
 *
 * The system prompt is NOT here: the agent meta object (identity + description +
 * channel source) rides `_meta.systemPrompt` on session/new|load for Claude runtimes
 * (see claudeSessionMeta), and for other runtimes SessionManager inlines it as the
 * first prompt text block. (`runtimeOverrides.env` is applied separately by
 * `agentChildEnv`.) Only emits a key when the value is set.
 */
export function cpRuntimeEnv(agent: Agent): Record<string, string> {
  const out: Record<string, string> = {}
  if (agent.runtimeOverrides?.model) out.AGENTCONNECT_MODEL = agent.runtimeOverrides.model
  if (agent.reasoningEffort) out.AGENTCONNECT_REASONING_EFFORT = agent.reasoningEffort
  if (agent.executionMode) out.AGENTCONNECT_EXECUTION_MODE = agent.executionMode
  return out
}
