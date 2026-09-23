// A memory plugin's bounded connection settings schema (memory-evolution.md §3.3.2) as typed console fields.

export interface SettingsOption {
  /** JSON-encoded value, stable as a `<select>` option value. */
  key: string
  value: unknown
  label: string
}

export interface SettingsField {
  name: string
  label: string
  description: string | null
  kind: 'string' | 'number' | 'boolean' | 'enum'
  integer: boolean
  required: boolean
  options: SettingsOption[]
  default: unknown
}

/** Form state: text for strings, numbers, and enum option keys; a flag for booleans. */
export type SettingsValues = Record<string, string | boolean>

export type SettingsError = { field: SettingsField; reason: 'required' | 'number' | 'integer' }

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** One field per property, or null when the schema needs the JSON fallback: a nested or multi-typed value. */
export function settingsFields(schema: unknown): SettingsField[] | null {
  const root = asObject(schema)
  const properties = root ? asObject(root.properties) : null
  if (!root || !properties) return null
  const required = new Set(
    Array.isArray(root.required) ? root.required.filter((name): name is string => typeof name === 'string') : []
  )
  const fields: SettingsField[] = []
  for (const [name, raw] of Object.entries(properties)) {
    const node = asObject(raw)
    if (!node) return null
    const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((type) => type !== 'null')
    const type = types.length === 1 && typeof types[0] === 'string' ? types[0] : null
    if (!type || !SCALAR_TYPES.has(type)) return null
    const options = Array.isArray(node.enum)
      ? node.enum.map((value) => ({ key: JSON.stringify(value), value, label: String(value) }))
      : []
    fields.push({
      name,
      label: typeof node.title === 'string' && node.title ? node.title : name,
      description: typeof node.description === 'string' && node.description ? node.description : null,
      kind: options.length ? 'enum' : type === 'boolean' ? 'boolean' : type === 'string' ? 'string' : 'number',
      integer: type === 'integer',
      required: required.has(name),
      options,
      default: node.default
    })
  }
  // JSONB storage loses the plugin's declared order, so the form settles on one: required first, then by label.
  return fields.sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label))
}

/** A typed form drops keys it does not know, so a config with extra keys stays on the JSON fallback. */
export function configFitsFields(config: Record<string, unknown>, fields: SettingsField[]): boolean {
  const known = new Set(fields.map((field) => field.name))
  return Object.keys(config).every((key) => known.has(key))
}

export function valuesFromConfig(fields: SettingsField[], config: Record<string, unknown>): SettingsValues {
  const values: SettingsValues = {}
  for (const field of fields) {
    const value = config[field.name] ?? field.default
    if (field.kind === 'boolean') values[field.name] = value === true
    else if (field.kind === 'enum') {
      const key = JSON.stringify(value)
      values[field.name] = field.options.some((option) => option.key === key) ? key : ''
    } else values[field.name] = value === undefined || value === null ? '' : String(value)
  }
  return values
}

export function configFromValues(
  fields: SettingsField[],
  values: SettingsValues
): { config: Record<string, unknown> } | { error: SettingsError } {
  const config: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (field.kind === 'boolean') {
      config[field.name] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (!text) {
      if (field.required) return { error: { field, reason: 'required' } }
      continue
    }
    if (field.kind === 'enum') {
      const option = field.options.find((candidate) => candidate.key === text)
      if (!option) return { error: { field, reason: 'required' } }
      config[field.name] = option.value
      continue
    }
    if (field.kind === 'number') {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return { error: { field, reason: 'number' } }
      if (field.integer && !Number.isInteger(parsed)) return { error: { field, reason: 'integer' } }
      config[field.name] = parsed
      continue
    }
    config[field.name] = text
  }
  return { config }
}
