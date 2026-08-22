import { z } from 'zod'

/**
 * The zod vocabulary every tool's argument schema is built from.
 *
 * Each builder carries the MODEL-FACING message text verbatim: an agent reads these errors and
 * repairs its own call from them, so the wording is as much a contract as the argument shape.
 * That is why the messages are attached per check here instead of relying on zod's defaults.
 */

/** Parse tool arguments, surfacing the first issue's message as a plain `Error` — the shape the
 *  MCP bridge turns into an `isError` result. */
export function parseArgs<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(parsed.error.issues[0]?.message ?? 'invalid tool arguments')
}

/** A required non-empty string argument. */
export function requiredString(key: string): z.ZodString {
  const message = `missing required string argument: ${key}`
  return z.string(message).min(1, message)
}

/** Like {@link requiredString} but accepts `''` — for `updateMemory`/`submitCodeReview`, where
 *  an empty string is a valid value. */
export function requiredStringAllowEmpty(key: string): z.ZodString {
  return z.string(`missing required string argument: ${key}`)
}

/** An optional string; `null` reads as absent, as it always has. */
export function optionalString(key: string) {
  return z
    .string(`argument ${key} must be a string`)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** An optional finite number. */
export function optionalNumber(key: string) {
  const message = `argument ${key} must be a finite number`
  return z
    .number(message)
    .refine(Number.isFinite, message)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** An optional integer inside an inclusive range. */
export function optionalBoundedInt(key: string, min: number, max: number) {
  return z
    .number(`argument ${key} must be a finite number`)
    .refine(Number.isFinite, `argument ${key} must be a finite number`)
    .refine(
      (value) => Number.isInteger(value) && value >= min && value <= max,
      `argument ${key} must be an integer between ${min} and ${max}`
    )
    .nullish()
    .transform((value) => value ?? undefined)
}

/** An optional boolean; `null` reads as absent, like every other optional here. */
export function optionalBoolean(key: string) {
  return z
    .boolean(`argument ${key} must be a boolean`)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** An optional plain JSON object (never an array). */
export function optionalObject(key: string) {
  const message = `argument ${key} must be an object`
  return z
    .custom<Record<string, unknown>>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      message
    )
    .nullish()
    .transform((value) => value ?? undefined)
}

/** A required enum argument. */
export function requiredEnum<const T extends readonly [string, ...string[]]>(key: string, values: T) {
  return z.enum(values, `argument ${key} must be one of: ${values.join(', ')}`)
}

/** An optional enum argument, same message as {@link requiredEnum}. */
export function optionalEnum<const T extends readonly [string, ...string[]]>(key: string, values: T) {
  return requiredEnum(key, values)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** A required integer > 0. */
export function requiredPositiveInt(key: string) {
  const message = `argument ${key} must be a positive integer`
  return z.int(message).min(1, message)
}

/** An optional integer > 0. */
export function optionalPositiveInt(key: string) {
  return requiredPositiveInt(key)
    .nullish()
    .transform((value) => value ?? undefined)
}

/** An optional numeric argument that keeps the historical `Number(value)` coercion (so `"3"`
 *  still works) and falls back to `fallback` when absent. */
export function coercedIntWithDefault(min: number, max: number, fallback: number, message: string) {
  return z
    .unknown()
    .optional()
    .transform((value) => (value === undefined ? fallback : Number(value)))
    .refine((value) => Number.isInteger(value) && value >= min && value <= max, message)
}
