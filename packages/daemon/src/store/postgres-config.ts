import { readFileSync } from 'node:fs'
import { z } from 'zod'

/** Kubernetes Secret mount consumed only by `--k8s`; no CLI/env credential surface exists. */
export const DATA_PLANE_CONFIG_PATH = '/var/run/ac-data-plane/config.json'

const PostgresUrl = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value)
      if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('scheme')
    } catch {
      ctx.addIssue({ code: 'custom', message: 'databaseUrl must be a PostgreSQL URL' })
    }
  })

export const DataPlaneConfigSchema = z
  .object({
    version: z.literal(1),
    databaseUrl: PostgresUrl,
    // Sizes the store's pg.Pool: since the async store runs on the main thread, this is the
    // store's concurrency knob — how many statements the pool member can have in flight.
    maxConnections: z.number().int().min(1).max(32).default(4)
  })
  .strict()

export type DataPlaneConfig = z.infer<typeof DataPlaneConfigSchema>

export function readDataPlaneConfig(path = DATA_PLANE_CONFIG_PATH): DataPlaneConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is not valid JSON' : 'is not readable'
    throw new Error(`data-plane configuration ${reason} at ${path}`)
  }
  const parsed = DataPlaneConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(
      `invalid data-plane configuration at ${path}: ${issue?.path.join('.') || 'document'} ${issue?.message}`
    )
  }
  return parsed.data
}
