import {
  effortChoicesFor,
  effortLabel,
  modelCapability,
  permissionModeChoicesFor,
  permissionModeDefault,
  permissionModeLabel,
  resolvedPermissionMode,
  resolveEffortForModel,
  type DaemonRow,
  type EffortChoice,
  type RuntimeModelCatalog,
  type Session
} from '@/lib/data'

type RuntimeDaemon = Pick<DaemonRow, 'runtimeModels'> | undefined
type PermissionChoice = { v: string; l: string; description?: string }

/** Playground can stage settings for its first turn; other chat surfaces need a live session. */
export function sessionRuntimeChangesEnabled(
  allowed: boolean,
  session: Pick<Session, 'platform' | 'realSessionId'>
): boolean {
  return allowed && (session.platform === 'playground' || session.platform === 'webchat' || !!session.realSessionId)
}

/** A received live list is authoritative, including `[]`; discovery is idle-session fallback only. */
export function sessionEffortChoices(
  runtime: string,
  daemon: RuntimeDaemon,
  model: string,
  liveValues: string[] | undefined
): EffortChoice[] {
  const discovered = effortChoicesFor(runtime, modelCapability(daemon, runtime, model))
  if (liveValues === undefined) return discovered
  return liveValues.map(
    (value) => discovered.find((choice) => choice.value === value) ?? { value, label: effortLabel(runtime, value) }
  )
}

/** Live efforts belong to the reported model, not an optimistic local selection. */
export function sessionEffortChoicesForSelection(
  runtime: string,
  daemon: RuntimeDaemon,
  selectedModel: string,
  reportedModel: string | undefined,
  liveValues: string[] | undefined
): EffortChoice[] {
  return sessionEffortChoices(runtime, daemon, selectedModel, selectedModel === reportedModel ? liveValues : undefined)
}

/** Permission capabilities follow the same live-first rule as model and effort selectors. */
export function sessionPermissionChoices(
  runtime: string,
  catalog: RuntimeModelCatalog | undefined,
  liveValues: string[] | undefined
): PermissionChoice[] {
  const discovered = permissionModeChoicesFor(runtime, catalog)
  if (liveValues === undefined) return discovered
  // A live daemon reports what its runtime actually advertises; preserve that list.
  return liveValues.map(
    (value) =>
      discovered.find((choice) => choice.v === value) ?? {
        v: value,
        l: permissionModeLabel(runtime, value)
      }
  )
}

/** Resolve the displayed permission while keeping an empty live list authoritative for menu availability. */
export function sessionPermissionSelection(
  runtime: string,
  catalog: RuntimeModelCatalog | undefined,
  liveValues: string[] | undefined,
  current: string
): string {
  const choices = sessionPermissionChoices(runtime, catalog, liveValues)
  const resolvedCurrent = current || catalog?.defaultPermissionMode || permissionModeDefault(runtime)
  if (choices.some((choice) => choice.v === resolvedCurrent)) return resolvedCurrent
  if (liveValues === undefined) return resolvedPermissionMode(resolvedCurrent, choices, catalog)
  if (choices.length === 0) return resolvedCurrent
  const defaultMode = catalog?.defaultPermissionMode
  if (defaultMode && choices.some((choice) => choice.v === defaultMode)) return defaultMode
  return choices[0]?.v ?? ''
}

/** Keep the sticky effort compatible with a user-selected model. */
export function sessionEffortAfterModelChange(
  runtime: string,
  daemon: RuntimeDaemon,
  model: string,
  currentEffort: string
): string {
  return resolveEffortForModel(runtime, modelCapability(daemon, runtime, model), currentEffort)
}

/** A live effort list describes the previous model until a new status frame arrives. */
export function sessionAfterModelSelection<T extends { availableEfforts?: string[] }>(
  session: T,
  model: string
): T & { model: string } {
  return { ...session, model, availableEfforts: undefined }
}
