import {
  agentPermissionDisplay,
  displayedEffort,
  effortChoicesFor,
  effortLabel,
  fastModeAvailableFor,
  modelCapability,
  preferredModelFor,
  runtimeDefaultModel,
  permissionModeChoicesFor,
  permissionModeDefault,
  permissionModeLabel,
  resolvedPermissionMode,
  resolveEffortForModel,
  type Agent,
  type DaemonRow,
  type EffortChoice,
  type RuntimeModelCatalog,
  type Session
} from '@/lib/data'
import { agentStrategyValue, strategyModelSource } from '@/lib/execution-strategy'
import { localizedPermissionChoices } from '@/lib/permission-mode-i18n'

type RuntimeDaemon = Pick<DaemonRow, 'runtimeModels'> | undefined
type PermissionChoice = { v: string; l: string; description?: string }

/** Runtime settings change from chat only when people there may also change settings. */
export function chatSettingsAllowed(agent: Pick<Agent, 'chatActions'> | undefined): boolean {
  return agent?.chatActions === 'settings'
}

/** Tool-call approvals are answered from chat when people there may also approve them. */
export function chatApprovalsAllowed(agent: Pick<Agent, 'chatActions'> | undefined): boolean {
  return agent?.chatActions === 'approve' || agent?.chatActions === 'settings'
}

/** Playground can stage settings for its first turn; other chat surfaces need a live session. Only the agent's editors and the conversation's owner change them; an unknown owner (an older Control Plane, or a conversation not yet sent) keeps the controls. */
export function sessionRuntimeChangesEnabled(
  agent: (Pick<Agent, 'chatActions'> & { canEdit?: boolean }) | undefined,
  session: Pick<Session, 'platform' | 'realSessionId'>,
  ownsConversation?: boolean | null
): boolean {
  return (
    chatSettingsAllowed(agent) &&
    (agent?.canEdit === true || ownsConversation !== false) &&
    (session.platform === 'playground' || session.platform === 'webchat' || !!session.realSessionId)
  )
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

const modelSlug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** The offered entry a runtime-reported concrete id names (`claude-haiku-5-5` for `haiku`, "Haiku 5.5"); else the id itself. */
export function catalogModelFor(
  reported: string,
  catalog: RuntimeModelCatalog | undefined,
  offered: readonly string[]
): string {
  if (offered.includes(reported)) return reported
  const id = modelSlug(reported)
  const entry = catalog?.models.find((model) => {
    if (!offered.includes(model.id)) return false
    if (modelSlug(model.id.replace(/\[[^\]]*\]$/, '')) === id) return true
    const name = model.name === undefined ? '' : modelSlug(model.name)
    return name !== '' && (id === name || id.endsWith(`-${name}`))
  })
  return entry?.id ?? reported
}

/** Everything a composer's runtime picker shows for a session: the model and its choices, effort, approval mode and fast mode. */
export function runtimePickerState({
  session,
  selection,
  owner,
  owningDaemon,
  agentRuntime,
  beforeFirstTurn,
  runtimeUnresolved,
  permissionT
}: {
  session: Pick<
    Session,
    | 'model'
    | 'effort'
    | 'permissionMode'
    | 'fastMode'
    | 'fastModeAvailable'
    | 'availableModels'
    | 'availableEfforts'
    | 'availablePermissionModes'
  >
  /** What the reader picked here and the session has not reported back yet. */
  selection?: { model?: string; effort?: string; permissionPreset?: string; fast?: boolean } | undefined
  owner: Agent | undefined
  owningDaemon: DaemonRow | undefined
  agentRuntime: string
  /** A playground before its first turn stages a choice instead of changing a live session. */
  beforeFirstTurn: boolean
  /** The runtime or model is still being decided or reported. */
  runtimeUnresolved: boolean
  permissionT: Parameters<typeof localizedPermissionChoices>[1]
}) {
  // Before a live list, models come from the catalog of the agent's strategy: the host install's for host and srt, the image's for a VM.
  const modelSource =
    owningDaemon &&
    strategyModelSource(owningDaemon, owner && !owningDaemon.pool ? agentStrategyValue(owner) : undefined)
  const runtimeProfile = modelSource?.runtimeModels.find((profile) => profile.runtime === agentRuntime)
  const runtimeCatalog = runtimeProfile?.modelCatalog ?? undefined
  const pgModels = session.availableModels ?? runtimeProfile?.models ?? []
  const reportedModel = session.model && catalogModelFor(session.model, runtimeCatalog, pgModels)
  const pgModel =
    selection?.model ??
    (beforeFirstTurn
      ? reportedModel || owner?.model || preferredModelFor(modelSource, agentRuntime)
      : (reportedModel ?? ''))
  // A resolved runtime that reported no concrete model ran its own default; the picker names that entry.
  const pgShownModel =
    pgModel || (!runtimeUnresolved && runtimeDefaultModel(owningDaemon, agentRuntime) ? 'default' : '')
  const pgModelOptions =
    pgModels.length > 0 && pgModel && !pgModels.includes(pgModel) ? [pgModel, ...pgModels] : pgModels
  const pickerSource = beforeFirstTurn
    ? modelSource
    : {
        runtimeModels: [
          { ...runtimeProfile, runtime: agentRuntime, version: runtimeProfile?.version ?? '', models: pgModelOptions }
        ]
      }
  const selectedModelCapability = modelCapability(owningDaemon, agentRuntime, pgModel)
  const pgEffortChoices = sessionEffortChoicesForSelection(
    agentRuntime,
    owningDaemon,
    pgModel,
    reportedModel,
    session.availableEfforts
  )
  const pgEffort = displayedEffort(
    selection?.effort ?? session.effort ?? owner?.reasoning ?? '',
    pgEffortChoices,
    selectedModelCapability?.defaultEffort
  )
  const pgEffortOptions =
    pgEffort && !pgEffortChoices.some((choice) => choice.value === pgEffort)
      ? [{ value: pgEffort, label: effortLabel(agentRuntime, pgEffort) }, ...pgEffortChoices]
      : pgEffortChoices
  const livePermissionModes = session.availablePermissionModes
  const selectablePermissionModes = sessionPermissionChoices(agentRuntime, runtimeCatalog, livePermissionModes)
  const pgPermissionPreset = sessionPermissionSelection(
    agentRuntime,
    runtimeCatalog,
    livePermissionModes,
    selection?.permissionPreset ?? session.permissionMode ?? owner?.permissionMode ?? ''
  )
  const pgPermissionPresets =
    livePermissionModes === undefined &&
    pgPermissionPreset &&
    !selectablePermissionModes.some((choice) => choice.v === pgPermissionPreset)
      ? [
          { v: pgPermissionPreset, l: permissionModeLabel(agentRuntime, pgPermissionPreset) },
          ...selectablePermissionModes
        ]
      : selectablePermissionModes
  // The picker's Approval choices; a mode the live list no longer offers keeps its readable name.
  const pgApprovalOptions = localizedPermissionChoices(
    pgPermissionPreset && !pgPermissionPresets.some((mode) => mode.v === pgPermissionPreset)
      ? [
          { v: pgPermissionPreset, l: agentPermissionDisplay(owningDaemon, agentRuntime, pgPermissionPreset) },
          ...pgPermissionPresets
        ]
      : pgPermissionPresets,
    permissionT
  )
  // The local pick first: an idle adopted session reports no status frame, so the switch would read stale.
  const pgFastMode = selection?.fast ?? session.fastMode ?? owner?.fastMode ?? false
  const pgFastModeAvailable =
    (pgModel === reportedModel ? session.fastModeAvailable : undefined) ??
    fastModeAvailableFor(agentRuntime, selectedModelCapability)
  return {
    modelSource,
    pgModel,
    pgShownModel,
    pgModelOptions,
    pickerSource,
    pgEffort,
    pgEffortOptions,
    pgPermissionPreset,
    pgApprovalOptions,
    pgFastMode,
    pgFastModeAvailable
  }
}
