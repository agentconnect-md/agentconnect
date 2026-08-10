import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ResolvedRuntimeCatalog } from './registry.js'

/** Path override for the declared runtime table (a mounted ConfigMap in a cluster). */
export const CLOUD_RUNTIMES_ENV = 'AGENTCONNECT_CLOUD_RUNTIMES'

const CloudRuntimeEntrySchema = z.object({
  id: z.string().min(1),
  /** Overrides the catalog's declared version — the image pin is authoritative for what actually ships. */
  version: z.string().optional(),
  /** Optional model snapshot; reported with `modelsSource: 'cached'` because no live probe confirmed it. */
  models: z.array(z.string()).optional()
})

export const CloudRuntimeTableSchema = z.object({ runtimes: z.array(CloudRuntimeEntrySchema).min(1) })

export type CloudRuntimeTable = z.infer<typeof CloudRuntimeTableSchema>
export type CloudRuntimeEntry = z.infer<typeof CloudRuntimeEntrySchema>

export function cloudRuntimesPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLOUD_RUNTIMES_ENV]?.trim()
  return override ? override : join(root, 'cloud-runtimes.json')
}

/**
 * Load the runtimes the runtime image declares it provides. `--cloud` cannot use
 * host executable discovery: the runtimes live in the sandbox image, not next to
 * the daemon, so presence is a declaration rather than something to detect.
 *
 * A missing file is undefined (the daemon then advertises no runtime and says so);
 * a malformed one throws, because silently running with no runtimes looks exactly
 * like a healthy daemon that nobody can use.
 */
export function loadCloudRuntimeTable(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): CloudRuntimeTable | undefined {
  const path = cloudRuntimesPath(root, env)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`cloud runtime table at ${path} is not valid JSON: ${(err as Error).message}`)
  }
  const result = CloudRuntimeTableSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `cloud runtime table at ${path} is invalid: ${result.error.issues[0]?.message ?? 'schema mismatch'}`
    )
  }
  return result.data
}

export interface DeclaredCatalogResult {
  catalog: ResolvedRuntimeCatalog
  /** Declared ids the resolved catalog knows nothing about — a table/image mismatch. */
  unresolved: string[]
  /** Declared curated-source ids: unlaunchable here, since curated admission needs a live probe. */
  rejectedCurated: string[]
  /** Declared ids whose command is a package launcher, so starting them fetches at run time. */
  packageLaunchers: string[]
  /** Model snapshots to seed, keyed by runtime id. */
  models: Record<string, string[]>
}

const PACKAGE_LAUNCHERS = new Set(['npx', 'uvx'])

/**
 * Project the resolved catalog down to what the image declares, replacing the
 * host-executable filter. Curated entries are dropped rather than left pending:
 * their admission gate requires a successful probe, and `--cloud` does not probe,
 * so keeping them would advertise runtimes that refuse to launch.
 */
export function declaredRuntimeCatalog(
  catalog: ResolvedRuntimeCatalog,
  table: CloudRuntimeTable
): DeclaredCatalogResult {
  const entries: ResolvedRuntimeCatalog['entries'] = {}
  const runtimes: ResolvedRuntimeCatalog['runtimes'] = {}
  const unresolved: string[] = []
  const rejectedCurated: string[] = []
  const packageLaunchers: string[] = []
  const models: Record<string, string[]> = {}

  for (const declared of table.runtimes) {
    const entry = catalog.entries[declared.id]
    if (!entry) {
      unresolved.push(declared.id)
      continue
    }
    if (entry.source === 'curated') {
      rejectedCurated.push(declared.id)
      continue
    }
    if (PACKAGE_LAUNCHERS.has(entry.runtime.command)) packageLaunchers.push(declared.id)
    entries[declared.id] = declared.version ? { ...entry, version: declared.version } : entry
    runtimes[declared.id] = entry.runtime
    if (declared.models?.length) models[declared.id] = [...declared.models]
  }

  return { catalog: { entries, runtimes }, unresolved, rejectedCurated, packageLaunchers, models }
}
