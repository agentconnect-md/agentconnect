import { z, type ZodType } from 'zod'
import type { ObjectToolSchema, ObjectUnionSchema, ToolDescriptor } from '../../tool-schema/descriptor.js'

/** Per-argument description clip: enough to name the shape, never the whole tool prose. */
const MAX_PROPERTY_DESCRIPTION_CHARS = 160
/** Past this the shape is re-rendered as names and types only — an error is a map back, not a manual. */
const MAX_ACCEPTED_CHARS = 700
/** How many sibling tools an unknown-key hint names before it stops being a hint. */
const MAX_SIBLING_HINTS = 3

type InputSchema = ToolDescriptor['inputSchema']

/** The object branches of an advertised input schema — one for a plain object, each `oneOf` for a union. */
function branches(schema: InputSchema): ObjectToolSchema[] {
  return 'oneOf' in schema && Array.isArray(schema.oneOf)
    ? (schema as ObjectUnionSchema).oneOf
    : [schema as ObjectToolSchema]
}

/** Every argument name the advertised schema accepts, across all branches. */
export function advertisedArgumentKeys(schema: InputSchema): Set<string> {
  const keys = new Set<string>()
  for (const branch of branches(schema)) for (const key of Object.keys(branch.properties ?? {})) keys.add(key)
  return keys
}

/** Keys the caller sent that the tool's advertised schema does not name. Empty when nothing was advertised. */
export function unknownArgumentKeys(schema: InputSchema, args: Record<string, unknown>): string[] {
  const accepted = advertisedArgumentKeys(schema)
  return Object.keys(args).filter((key) => !accepted.has(key))
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PROPERTY_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_PROPERTY_DESCRIPTION_CHARS - 1)}…` : flat
}

function propertyType(value: unknown): string {
  const prop = (value ?? {}) as { type?: unknown; enum?: unknown; items?: { type?: unknown } }
  if (Array.isArray(prop.enum)) return prop.enum.map((entry) => JSON.stringify(entry)).join(' | ')
  if (prop.type === 'array') return `${typeof prop.items?.type === 'string' ? prop.items.type : 'any'}[]`
  return typeof prop.type === 'string' ? prop.type : 'any'
}

/** `{ key?: type — description; … }` for one object branch, `{}` when the tool takes nothing. */
function renderBranch(schema: ObjectToolSchema, describe: boolean): string {
  const required = new Set(schema.required ?? [])
  const rows = Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const description = (value as { description?: unknown } | null)?.description
    const suffix = describe && typeof description === 'string' && description.trim() ? ` — ${clip(description)}` : ''
    return `${key}${required.has(key) ? '' : '?'}: ${propertyType(value)}${suffix}`
  })
  return rows.length === 0 ? '{} (this tool takes no arguments)' : `{ ${rows.join('; ')} }`
}

/** One branch with descriptions, a union as bare alternatives; names and types only when that would run long. */
function renderShape(all: ObjectToolSchema[]): string {
  const render = (describe: boolean) =>
    all.length === 1 ? renderBranch(all[0]!, describe) : `one of ${all.map((b) => renderBranch(b, false)).join(' | ')}`
  const described = render(true)
  return described.length > MAX_ACCEPTED_CHARS ? render(false) : described
}

/** The accepted shape from the advertised descriptor, else from the validator (dispatch-only aliases). */
function renderAccepted(advertised: ToolDescriptor | undefined, fallback: ZodType | undefined): string | undefined {
  if (advertised) return renderShape(branches(advertised.inputSchema))
  if (!fallback) return undefined
  try {
    const projected = z.toJSONSchema(fallback, { io: 'input', unrepresentable: 'any' }) as Partial<ObjectToolSchema>
    if (projected.type !== 'object') return undefined
    return renderShape([
      { ...projected, properties: projected.properties ?? {}, required: projected.required ?? [] } as ObjectToolSchema
    ])
  } catch {
    return undefined
  }
}

/** Sibling tools whose arguments cover EVERY unknown key — the "those are writeMemory arguments" hint. */
function siblingOwners(unknown: string[], tool: string, siblings: readonly ToolDescriptor[]): string[] {
  if (unknown.length === 0) return []
  const owners: string[] = []
  for (const sibling of siblings) {
    if (sibling.name === tool) continue
    const accepted = advertisedArgumentKeys(sibling.inputSchema)
    if (unknown.every((key) => accepted.has(key))) owners.push(sibling.name)
  }
  return owners
}

export interface ToolArgumentFailure {
  tool: string
  /** The validator's own messages, or a synthesized one for unknown keys. */
  issues: readonly string[]
  /** Keys the caller actually sent (names only — values never enter an error). */
  receivedKeys: readonly string[]
  /** The descriptor this session was advertised for `tool`, when it has one. */
  advertised?: ToolDescriptor
  /** The session's whole advertised tool set, for the sibling hint. */
  tools: readonly ToolDescriptor[]
  /** The dispatch validator, rendered only when no descriptor was advertised. */
  validator?: ZodType
}

/** The model-facing rejection: tool, every issue, accepted shape, received keys, and the sibling that owns strays. */
export function describeToolArgumentFailure(failure: ToolArgumentFailure): string {
  const lines = [`${failure.tool}: invalid arguments — ${failure.issues.join('; ')}.`]
  const accepted = renderAccepted(failure.advertised, failure.validator)
  if (accepted) lines.push(`Accepted arguments: ${accepted}`)
  const received = failure.receivedKeys.length > 0 ? failure.receivedKeys.join(', ') : '(none)'
  const unknown = failure.advertised
    ? failure.receivedKeys.filter((key) => !advertisedArgumentKeys(failure.advertised!.inputSchema).has(key))
    : []
  let receivedLine = `Received keys: ${received}.`
  if (unknown.length > 0) {
    const owners = siblingOwners(unknown, failure.tool, failure.tools).slice(0, MAX_SIBLING_HINTS)
    receivedLine += ` Not accepted by ${failure.tool}: ${unknown.join(', ')}`
    receivedLine += owners.length > 0 ? ` — those are ${owners.join(' / ')} arguments.` : '.'
  }
  lines.push(receivedLine)
  return lines.join('\n')
}
