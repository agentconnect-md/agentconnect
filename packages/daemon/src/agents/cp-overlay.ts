// Maps the Control Plane agent spec to the ACP child's AgentConnect environment.
import type { Agent } from './agent-schema.js'

// ACP selectors also receive these settings; standing context and user environment travel separately.
export function cpRuntimeEnv(agent: Agent): Record<string, string> {
  const out: Record<string, string> = {}
  if (agent.runtimeOverrides?.model) out.AGENTCONNECT_MODEL = agent.runtimeOverrides.model
  if (agent.reasoningEffort) out.AGENTCONNECT_REASONING_EFFORT = agent.reasoningEffort
  if (agent.executionMode) out.AGENTCONNECT_EXECUTION_MODE = agent.executionMode
  return out
}
