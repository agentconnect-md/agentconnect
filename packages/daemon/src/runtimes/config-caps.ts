import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { EffortOption, PermissionModeOption } from '@agentconnect.md/protocol'
import { augmentClaudeEfforts } from '../runtime-defs/claude-runtime.js'

/** One model select option: the picker's value plus the runtime's own display metadata. */
export interface ModelChoice {
  value: string
  name?: string
  description?: string
}

/**
 * Distill a session's RAW ACP config options into the capability shape the
 * model-catalog cache stores (design doc runtime-model-catalog.md §4/§5).
 * Everything but `modelChoices` describes the CURRENTLY SELECTED model — the enumerator
 * calls this once per set_config_option response to build the per-model matrix, and the
 * probe sweep calls it once to seed the default model's entry plus the whole picker's names.
 *
 * Values are stored raw: daemon-side synthetic effort levels (Claude
 * max/ultracode) are appended at REPORT time, never here.
 */
export interface ConfigCaps {
  /** The model selector's currentValue (may be the literal "default"). */
  currentModel?: string
  /** Display name of the current model, only when it differs from the value. */
  modelName?: string
  /** Display metadata for EVERY model the selector offers, not just the current one. */
  modelChoices?: ModelChoice[]
  /** thought_level choices offered for the current model; [] = no effort selector. */
  efforts: EffortOption[]
  /** The effort the runtime defaulted the current model to. */
  defaultEffort?: string
  /** Whether a model_config (fast-mode) toggle exists for the current model. */
  fastMode: boolean
  /** Runtime-level permission modes (category "mode"), model-independent. */
  permissionModes?: PermissionModeOption[]
  /** The mode select's currentValue — the runtime's default permission mode. */
  currentPermissionMode?: string
}

type SelectValue = { value: string; name?: string | null; description?: string | null }

function selectFor(
  options: SessionConfigOption[],
  category: string
): (SessionConfigOption & { type: 'select' }) | undefined {
  return options.find(
    (o): o is SessionConfigOption & { type: 'select' } => o.category === category && o.type === 'select'
  )
}

/** `options` is either a flat SelectOption[] or a SelectGroup[]; flatten groups. */
function flatValues(opt: SessionConfigOption & { type: 'select' }): SelectValue[] {
  return (opt.options as Array<SelectValue | { group: string; options: SelectValue[] }>).flatMap((o) =>
    'group' in o ? o.options : [o]
  )
}

function configChoice(v: SelectValue) {
  return {
    value: v.value,
    ...(v.name && v.name !== v.value ? { name: v.name } : {}),
    ...(v.description ? { description: v.description } : {})
  }
}

/** Report-time Claude augmentation over EffortOption entries: appends the
 *  daemon-side synthetic levels (max/ultracode) the live-session pickers offer,
 *  via the same shared core, so cache stays raw and both surfaces agree. An
 *  empty list stays empty — a model without an effort selector gains nothing. */
export function augmentEffortOptions(efforts: EffortOption[]): EffortOption[] {
  const values = efforts.map((e) => e.value)
  const added = augmentClaudeEfforts(values).filter((v) => !values.includes(v))
  return added.length === 0 ? efforts : [...efforts, ...added.map((value) => ({ value }))]
}

export function capsFromConfigOptions(options: SessionConfigOption[]): ConfigCaps {
  const model = selectFor(options, 'model')
  const currentModel = model?.currentValue
  const modelChoices = model ? flatValues(model).map(configChoice) : undefined
  const modelName = modelChoices?.find((v) => v.value === currentModel)?.name

  const effort = selectFor(options, 'thought_level')
  const efforts = effort ? flatValues(effort).map(configChoice) : []
  const defaultEffort = effort?.currentValue

  // Availability is presence: the fast toggle option only exists once a
  // fast-capable model is selected (select on most agents, boolean when the
  // client negotiated the capability).
  const fastMode = options.some((o) => o.category === 'model_config')

  const mode = selectFor(options, 'mode')
  const permissionModes = mode ? flatValues(mode).map(configChoice) : undefined
  const currentPermissionMode = mode?.currentValue

  return {
    ...(currentModel ? { currentModel } : {}),
    ...(modelName && modelName !== currentModel ? { modelName } : {}),
    ...(modelChoices ? { modelChoices } : {}),
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    fastMode,
    ...(permissionModes ? { permissionModes } : {}),
    ...(currentPermissionMode ? { currentPermissionMode } : {})
  }
}
