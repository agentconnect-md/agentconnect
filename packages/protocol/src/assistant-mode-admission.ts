import { z } from 'zod'
import type { AgentMemoryBinding } from './frames/memory-connection.js'

/** What assistant mode needs from a runtime (assistant-mode.md §4.1); false means not established. */
export interface AssistantModeRuntimeFacts {
  /** The runtime's own cross-session memory can be turned off. */
  nativeMemoryDisableable: boolean
  /** A session resumes by id after the runtime process restarts. */
  resumesById: boolean
  /** What each known permission mode does to work nobody watches; a mode absent here is left as it is. */
  permissionModes?: Readonly<Record<string, AssistantModePermissionKind>>
}

/** `asks` waits for a person and `read-only` cannot write; `auto` decides by the runtime's own review; `full-access` never asks. */
export type AssistantModePermissionKind = 'asks' | 'read-only' | 'auto' | 'full-access'

const CLAUDE_PERMISSION_MODES = Object.freeze({
  default: 'asks',
  acceptEdits: 'asks',
  plan: 'read-only',
  auto: 'auto',
  bypassPermissions: 'full-access'
} as const)

// Codex's `agent` is its "Auto review": a reviewer model answers the requests a person would otherwise get.
const CODEX_PERMISSION_MODES = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'asks',
  agent: 'auto',
  'agent-full-access': 'full-access'
} as const)

/** The admission list, keyed by runtime id; a runtime absent here is not admitted. */
export const ASSISTANT_MODE_RUNTIME_FACTS: Readonly<Record<string, AssistantModeRuntimeFacts>> = Object.freeze({
  // Memory off via CLAUDE_CODE_DISABLE_AUTO_MEMORY; session/load resumes from the adapter's on-disk transcript.
  'claude-acp': { nativeMemoryDisableable: true, resumesById: true, permissionModes: CLAUDE_PERMISSION_MODES },
  // The earlier daemon generation's id for the same Claude adapter.
  claude: { nativeMemoryDisableable: true, resumesById: true, permissionModes: CLAUDE_PERMISSION_MODES },
  // Memory off via the memories feature flag; resuming by id after a restart is unverified (assistant-mode.md §9).
  'codex-acp': { nativeMemoryDisableable: true, resumesById: false, permissionModes: CODEX_PERMISSION_MODES },
  codex: { nativeMemoryDisableable: true, resumesById: false, permissionModes: CODEX_PERMISSION_MODES },
  // No automatic native memory store; resuming by id after a restart is unverified.
  opencode: { nativeMemoryDisableable: true, resumesById: false }
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

const factsOf = (
  runtime: string,
  table: Readonly<Record<string, AssistantModeRuntimeFacts>>
): AssistantModeRuntimeFacts | undefined =>
  Object.prototype.hasOwnProperty.call(table, runtime) ? table[runtime] : undefined

/** Whether a runtime id is on the admission list with every fact established. */
export function assistantModeRuntimeAdmitted(runtime: string): boolean {
  const facts = factsOf(runtime, ASSISTANT_MODE_RUNTIME_FACTS)
  return facts !== undefined && facts.nativeMemoryDisableable && facts.resumesById
}

/** The permission mode turning assistant mode on sets (assistant-mode.md §1.8): the runtime's auto mode, else its full-access one; undefined keeps the mode. */
export function assistantModePermissionModeOnEnable(
  runtime: string | null | undefined,
  permissionMode: string | null | undefined,
  table: Readonly<Record<string, AssistantModeRuntimeFacts>> = ASSISTANT_MODE_RUNTIME_FACTS
): string | undefined {
  const modes = runtime ? factsOf(runtime, table)?.permissionModes : undefined
  if (!modes) return undefined
  const entries = Object.entries(modes)
  const target =
    entries.find(([, kind]) => kind === 'auto')?.[0] ?? entries.find(([, kind]) => kind === 'full-access')?.[0]
  if (!target) return undefined
  // Unset is the runtime's own default, which the Control Plane cannot see.
  if (!permissionMode) return target
  const kind = Object.prototype.hasOwnProperty.call(modes, permissionMode) ? modes[permissionMode] : undefined
  return kind === 'asks' || kind === 'read-only' ? target : undefined
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
