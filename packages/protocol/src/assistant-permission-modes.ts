// The permission mode switching assistant mode on sets (assistant-mode.md §1.8), also the console's default for a new agent; a leaf module, so the console may import it.

/** `asks` waits for a person and `read-only` cannot write; `auto` decides by the runtime's own review; `full-access` never asks. */
export type AssistantModePermissionKind = 'asks' | 'read-only' | 'auto' | 'full-access'

/** Each known permission mode of one runtime, by what it does to work nobody watches; a mode absent here is left as it is. */
export type AssistantModePermissionModes = Readonly<Record<string, AssistantModePermissionKind>>

const CLAUDE_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  default: 'asks',
  acceptEdits: 'asks',
  plan: 'read-only',
  auto: 'auto',
  bypassPermissions: 'full-access'
})

// Codex's `agent` is its "Auto review": a reviewer model answers the requests a person would otherwise get.
const CODEX_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'asks',
  agent: 'auto',
  'agent-full-access': 'full-access'
})

/** The admitted runtimes' permission modes, keyed by runtime id; a runtime absent here keeps its mode. */
export const ASSISTANT_MODE_PERMISSION_MODES: Readonly<Record<string, AssistantModePermissionModes>> = Object.freeze({
  'claude-acp': CLAUDE_PERMISSION_MODES,
  claude: CLAUDE_PERMISSION_MODES,
  'codex-acp': CODEX_PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES
})

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/** The runtime's auto mode, else its full-access one, among the modes its catalog offers (every mode it knows when unsaid); undefined when it has neither. */
export function autoOrFullAccessPermissionMode(
  runtime: string | null | undefined,
  offered?: readonly string[],
  table: Readonly<Record<string, AssistantModePermissionModes>> = ASSISTANT_MODE_PERMISSION_MODES
): string | undefined {
  const modes = runtime ? own(table, runtime) : undefined
  if (!modes) return undefined
  const entries = Object.entries(modes).filter(([mode]) => !offered || offered.includes(mode))
  return entries.find(([, kind]) => kind === 'auto')?.[0] ?? entries.find(([, kind]) => kind === 'full-access')?.[0]
}

/** The runtime's auto mode, else its full-access one, when the current mode would wait or cannot write; undefined keeps the mode. */
export function assistantModePermissionModeOnEnable(
  runtime: string | null | undefined,
  permissionMode: string | null | undefined,
  table: Readonly<Record<string, AssistantModePermissionModes>> = ASSISTANT_MODE_PERMISSION_MODES
): string | undefined {
  const modes = runtime ? own(table, runtime) : undefined
  if (!modes) return undefined
  const target = autoOrFullAccessPermissionMode(runtime, undefined, table)
  if (!target) return undefined
  // Unset is the runtime's own default, which the Control Plane cannot see.
  if (!permissionMode) return target
  const kind = own(modes, permissionMode)
  return kind === 'asks' || kind === 'read-only' ? target : undefined
}
