/**
 * Pure projections over the `/models` `/effort` `/permission` select state: label,
 * options, display alias, card header, and the setter dispatch. The sticky-override
 * setters arrive as a `SelectSetters` table rather than being read off the daemon.
 */

import { permissionModeDisplayLabel } from '../acp/permission-modes.js'
import type { SelectKind } from '../platforms/command-chrome.js'
import type { StatusBarInfo } from '../slack/render.js'

/** Per-kind sticky-override setters, keyed by select kind. */
export type SelectSetters = Record<SelectKind, (key: string, value: string) => Promise<boolean>>

export function selectLabel(kind: SelectKind): string {
  return kind === 'model' ? 'Model' : kind === 'effort' ? 'Reasoning effort' : 'Permission mode'
}

/** Current value + selectable options for a select kind, from a status snapshot. */
export function selectOptions(kind: SelectKind, info: StatusBarInfo): { current?: string; options: string[] } {
  if (kind === 'model') return { current: info.model, options: info.models ?? [] }
  if (kind === 'effort') return { current: info.effort, options: info.efforts ?? [] }
  return { current: info.permissionMode, options: info.permissionModes ?? [] }
}

/** Apply a resolved select value to a session key via the matching sticky-override setter. */
export function applySelect(kind: SelectKind, key: string, value: string, setters: SelectSetters): Promise<boolean> {
  return setters[kind](key, value)
}

/** Display alias: permission modes read as their Codex names; model/effort render verbatim. */
export function selectDisplay(kind: SelectKind, value: string): string {
  return kind === 'permission' ? permissionModeDisplayLabel(value) : value
}

/** Header line for a select card (Telegram inline-keyboard card and Discord button card). */
export function selectCardText(kind: SelectKind, current: string | undefined): string {
  const cur = current ? selectDisplay(kind, current) : 'default'
  return `${selectLabel(kind)} — tap to switch (current: ${cur}):`
}
