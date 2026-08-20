import { z } from 'zod'

/**
 * Tolerant readers — the reading end of a payload its peer AUTHORS (protocol §1).
 *
 * A `.strict()` payload object refuses an unknown key. That is the right check
 * on the receiving end of a REQUEST, and a liability on the receiving end of a
 * REPLY: the writer upgrades first, so one optional field added to a CP-authored
 * payload makes every older reader reject the WHOLE frame — and for `register/ok`
 * that is the handshake, failing identically on every retry. `tolerantReader`
 * rebuilds a schema with every strict object relaxed to zod's default strip, so a
 * field the reader predates is dropped instead of fatal. Nothing else moves: a
 * wrong type, a missing required field, and every refinement still reject.
 */

/** Structural view of a zod `_zod.def` — the child slots this rebuild traverses. */
type SchemaDef = { type: string } & Record<string, unknown>

const memo = new WeakMap<z.ZodType, z.ZodType>()

/** `schema` with every strict object relaxed to strip, memoized per schema instance. */
export function tolerantReader<T extends z.ZodType>(schema: T): T {
  const hit = memo.get(schema)
  if (hit) return hit as T
  const built = rebuild(schema)
  memo.set(schema, built)
  return built as T
}

/** One whole wire's `type` → payload map, read tolerantly. */
export function tolerantSchemas<M extends Record<string, z.ZodType>>(schemas: M): M {
  return Object.fromEntries(Object.entries(schemas).map(([type, schema]) => [type, tolerantReader(schema)])) as M
}

/** Is `value` a schema (any zod type carries `_zod`)? */
function isSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value
}

function defOf(schema: z.ZodType): SchemaDef {
  return schema._zod.def as SchemaDef
}

function child(value: unknown): z.ZodType {
  return tolerantReader(value as z.ZodType)
}

/** Clone with a patched def; zod re-derives the parser from the constructor. */
function withDef(schema: z.ZodType, def: SchemaDef): z.ZodType {
  return z.clone(schema, def as never)
}

/** Rebuild one schema and everything reachable under it. Cycles need `lazy`, which defers. */
function rebuild(schema: z.ZodType): z.ZodType {
  const def = defOf(schema)
  switch (def.type) {
    case 'object': {
      const shape = Object.fromEntries(
        Object.entries(def.shape as Record<string, z.ZodType>).map(([key, value]) => [key, child(value)])
      )
      // `.strict()` is a `never` catchall; a declared `.catchall(...)` is a real key policy and stays.
      const catchall = isNeverSchema(def.catchall) ? undefined : def.catchall ? child(def.catchall) : undefined
      return withDef(schema, { ...def, shape, catchall })
    }
    case 'array':
      return withDef(schema, { ...def, element: child(def.element) })
    // Both plain and discriminated unions; the discriminator rides along in the spread def.
    case 'union':
      return withDef(schema, { ...def, options: (def.options as z.ZodType[]).map(child) })
    case 'intersection':
      return withDef(schema, { ...def, left: child(def.left), right: child(def.right) })
    case 'tuple':
      return withDef(schema, {
        ...def,
        items: (def.items as z.ZodType[]).map(child),
        ...(isSchema(def.rest) ? { rest: child(def.rest) } : {})
      })
    case 'record':
    case 'map':
      return withDef(schema, { ...def, keyType: child(def.keyType), valueType: child(def.valueType) })
    case 'set':
      return withDef(schema, { ...def, valueType: child(def.valueType) })
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'promise':
      return withDef(schema, { ...def, innerType: child(def.innerType) })
    case 'pipe':
      return withDef(schema, { ...def, in: child(def.in), out: child(def.out) })
    case 'lazy':
      return z.lazy(() => child((def.getter as () => z.ZodType)()))
    default:
      // A leaf (string, number, literal, enum, custom, …) carries no object to relax.
      return schema
  }
}

/** The `never` catchall `.strict()` installs — the one thing this rebuild removes. */
export function isStrictObject(schema: z.ZodType): boolean {
  const def = defOf(schema)
  return def.type === 'object' && isNeverSchema(def.catchall)
}

function isNeverSchema(value: unknown): boolean {
  return isSchema(value) && defOf(value).type === 'never'
}

/** Every schema reachable from `schema`, found by scanning def slots rather than by type. */
export function reachableSchemas(schema: z.ZodType, seen = new Set<z.ZodType>()): Set<z.ZodType> {
  if (seen.has(schema)) return seen
  seen.add(schema)
  for (const value of Object.values(defOf(schema))) visit(value, seen)
  return seen
}

function visit(value: unknown, seen: Set<z.ZodType>): void {
  if (isSchema(value)) {
    reachableSchemas(value, seen)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) visit(item, seen)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) visit(item, seen)
  }
}
