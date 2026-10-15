import { z } from 'zod'
import type { AgentMemoryBinding } from './frames/memory-connection.js'

/** What assistant mode needs from a runtime (assistant-mode.md §4.1); false means not established. */
export interface AssistantModeRuntimeFacts {
  /** The runtime's own cross-session memory can be turned off. */
  nativeMemoryDisableable: boolean
  /** A session resumes by id after the runtime process restarts. */
  resumesById: boolean
}

/** The admission list, keyed by runtime id; a runtime absent here is not admitted. */
export const ASSISTANT_MODE_RUNTIME_FACTS: Readonly<Record<string, AssistantModeRuntimeFacts>> = Object.freeze({
  // Memory off via CLAUDE_CODE_DISABLE_AUTO_MEMORY; session/load resumes from the adapter's on-disk transcript.
  'claude-acp': { nativeMemoryDisableable: true, resumesById: true },
  // The earlier daemon generation's id for the same Claude adapter.
  claude: { nativeMemoryDisableable: true, resumesById: true },
  // Memory off via the memories feature flag; session/load resumes the thread from its rollout under CODEX_HOME.
  'codex-acp': { nativeMemoryDisableable: true, resumesById: true },
  // The earlier daemon generation's id for the same Codex adapter.
  codex: { nativeMemoryDisableable: true, resumesById: true },
  // No automatic native memory store; session/load resumes from its session database under XDG_DATA_HOME.
  opencode: { nativeMemoryDisableable: true, resumesById: true }
})

/** Why an agent cannot switch assistant mode on; the console shows each as the lock reason. */
export const AssistantModeRefusal = z.enum([
  'runtime-unset',
  'runtime-not-admitted',
  'memory-provider',
  'store-not-shared'
])
export type AssistantModeRefusal = z.infer<typeof AssistantModeRefusal>

export const AssistantModeAdmission = z.object({
  admitted: z.boolean(),
  refusals: z.array(AssistantModeRefusal)
})
export type AssistantModeAdmission = z.infer<typeof AssistantModeAdmission>

/** Whether a runtime id is on the admission list with every fact established. */
export function assistantModeRuntimeAdmitted(runtime: string): boolean {
  const facts = Object.prototype.hasOwnProperty.call(ASSISTANT_MODE_RUNTIME_FACTS, runtime)
    ? ASSISTANT_MODE_RUNTIME_FACTS[runtime]
    : undefined
  return facts !== undefined && facts.nativeMemoryDisableable && facts.resumesById
}

/** The checks an agent's own definition decides; the store check needs its placement and is the Control Plane's. */
export function assistantModeDefinitionRefusals(agent: {
  runtime: string | null | undefined
  memory: AgentMemoryBinding | null | undefined
}): AssistantModeRefusal[] {
  const refusals: AssistantModeRefusal[] = []
  if (!agent.runtime) refusals.push('runtime-unset')
  else if (!assistantModeRuntimeAdmitted(agent.runtime)) refusals.push('runtime-not-admitted')
  // No binding means the managed default.
  const provider = agent.memory?.provider ?? 'managed'
  if (provider !== 'managed' && provider !== 'none') refusals.push('memory-provider')
  return refusals
}
