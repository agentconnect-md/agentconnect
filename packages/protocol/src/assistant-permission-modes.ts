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

// Every mode below is classified by the description the runtime itself reports; a mode whose description leaves approvals unclear is absent.

// Google Antigravity: `auto_edit` approves only file edits, `yolo` every tool.
const ANTIGRAVITY_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  default: 'asks',
  auto_edit: 'asks',
  yolo: 'full-access'
})

// CodeBuddy Code: `auto` is its safety classifier; `dontAsk` refuses rather than asks and `delegate` defers to a parent session.
const CODEBUDDY_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  default: 'asks',
  acceptEdits: 'asks',
  plan: 'read-only',
  auto: 'auto',
  bypassPermissions: 'full-access',
  fullAccess: 'full-access'
})

// Devin: `smart` approves what the model judges safe; `accept-edits` and `plan` do not say whether they ask.
const DEVIN_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  ask: 'read-only',
  smart: 'auto',
  bypass: 'full-access'
})

// DeepSeek Harness: `danger-full-access` drops both its sandbox and its prompts.
const DSH_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'asks',
  'danger-full-access': 'full-access'
})

// Copilot names its modes by URL; only Autopilot, which allows all, says how it approves.
const COPILOT_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  'https://agentclientprotocol.com/protocol/session-modes#autopilot': 'full-access'
})

// Qoder CLI: `auto` is its safety classifier; `dontAsk` refuses rather than asks, as Claude Code's does.
const QODER_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  default: 'asks',
  acceptEdits: 'asks',
  auto: 'auto',
  yolo: 'full-access'
})

// Qwen Code: `auto` is a model classifier; `auto-edit` approves only file edits.
const QWEN_PERMISSION_MODES: AssistantModePermissionModes = Object.freeze({
  plan: 'read-only',
  default: 'asks',
  'auto-edit': 'asks',
  auto: 'auto',
  yolo: 'full-access'
})

/** Each runtime's permission modes, keyed by runtime id; a runtime absent here keeps its mode. */
export const ASSISTANT_MODE_PERMISSION_MODES: Readonly<Record<string, AssistantModePermissionModes>> = Object.freeze({
  'claude-acp': CLAUDE_PERMISSION_MODES,
  claude: CLAUDE_PERMISSION_MODES,
  'codex-acp': CODEX_PERMISSION_MODES,
  codex: CODEX_PERMISSION_MODES,
  'antigravity-acp': ANTIGRAVITY_PERMISSION_MODES,
  'codebuddy-code': CODEBUDDY_PERMISSION_MODES,
  devin: DEVIN_PERMISSION_MODES,
  'dsh-acp': DSH_PERMISSION_MODES,
  'github-copilot-cli': COPILOT_PERMISSION_MODES,
  qoder: QODER_PERMISSION_MODES,
  'qoder-cli': QODER_PERMISSION_MODES,
  'qoder-cli-cn': QODER_PERMISSION_MODES,
  'qwen-code': QWEN_PERMISSION_MODES
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
