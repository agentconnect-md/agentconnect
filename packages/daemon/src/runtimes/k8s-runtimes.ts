import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ResolvedRuntimeCatalog } from './registry.js'

/** Path override for the declared runtime table (a mounted ConfigMap in a cluster). */
export const K8S_RUNTIMES_ENV = 'AGENTCONNECT_K8S_RUNTIMES'

/**
 * What the runtime image observed at `initialize`, published so `--k8s` can report it without
 * probing. Only the fields the daemon actually reports are typed — an unrecognized key here would
 * be silently dropped, which is how the first version of this shipped a snapshot nothing consumed.
 */
const K8sRuntimeAcpSchema = z.object({
  protocolVersion: z.number().int().nonnegative().optional(),
  agentName: z.string().optional(),
  authMethods: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  modes: z.array(z.string()).optional(),
  /** The model/permission/effort surface a session offers; what the console renders. */
  configOptions: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Whether a session could be opened during the image probe, so an empty mode list is a
   *  recorded fact rather than a gap. */
  sessionProbe: z.enum(['ok', 'auth-required']).optional()
})
export type K8sRuntimeAcpSnapshot = z.infer<typeof K8sRuntimeAcpSchema>

const K8sRuntimeEntrySchema = z.object({
  id: z.string().min(1),
  /** Overrides the catalog's declared version — the image pin is authoritative for what actually ships. */
  version: z.string().optional(),
  /** Optional model snapshot; reported with `modelsSource: 'cached'` because no live probe confirmed it. */
  models: z.array(z.string()).optional(),
  /**
   * The executable the IMAGE launches this runtime as, and its arguments.
   *
   * Authoritative over the resolved catalog, for the same reason the version is: how a runtime is
   * launched is a property of the image that ships it, not something a daemon-side config should
   * assert about a filesystem it cannot see. It is also what makes the public registry's `npx`
   * distribution usable here — the image installed a real executable, and only the image knows
   * its name.
   */
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  /** The image's `initialize` snapshot for this runtime. */
  acp: K8sRuntimeAcpSchema.optional()
})

export const K8sRuntimeTableSchema = z.object({ runtimes: z.array(K8sRuntimeEntrySchema).min(1) })

export type K8sRuntimeTable = z.infer<typeof K8sRuntimeTableSchema>
export type K8sRuntimeEntry = z.infer<typeof K8sRuntimeEntrySchema>

export function k8sRuntimesPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[K8S_RUNTIMES_ENV]?.trim()
  return override ? override : join(root, 'k8s-runtimes.json')
}

/**
 * Load the runtimes the runtime image declares it provides. `--k8s` cannot use
 * host executable discovery: the runtimes live in the sandbox image, not next to
 * the daemon, so presence is a declaration rather than something to detect.
 *
 * A missing file is undefined (the daemon then advertises no runtime and says so);
 * a malformed one throws, because silently running with no runtimes looks exactly
 * like a healthy daemon that nobody can use.
 */
export function loadK8sRuntimeTable(root: string, env: NodeJS.ProcessEnv = process.env): K8sRuntimeTable | undefined {
  const path = k8sRuntimesPath(root, env)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`k8s runtime table at ${path} is not valid JSON: ${(err as Error).message}`)
  }
  const result = K8sRuntimeTableSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`k8s runtime table at ${path} is invalid: ${result.error.issues[0]?.message ?? 'schema mismatch'}`)
  }
  return result.data
}

export interface DeclaredCatalogResult {
  catalog: ResolvedRuntimeCatalog
  /** Declared ids the resolved catalog knows nothing about — a table/image mismatch. */
  unresolved: string[]
  /** Declared curated ids the image did not probe into an executable: still unlaunchable here. */
  rejectedCurated: string[]
  /** Declared ids that launch through a package manager, so their artifact is not the image's. */
  rejectedPackageLaunchers: string[]
  /** Model snapshots to seed, keyed by runtime id. */
  models: Record<string, string[]>
  /** Per-runtime `initialize` snapshot from the image, keyed by runtime id. */
  acp: Record<string, K8sRuntimeAcpSnapshot>
}

const PACKAGE_LAUNCHERS = new Set(['npx', 'uvx'])

/**
 * Project the resolved catalog down to what the image declares, replacing the
 * host-executable filter. Two classes of declared runtime are dropped rather than
 * advertised, because either would break at first use:
 *
 * - curated entries the image did NOT install as its own executable and probe:
 *   curated admission is a successful ACP probe, and `--k8s` never runs one. An
 *   entry the image declares with a command AND its build-time `initialize`
 *   snapshot already carries that evidence — taken in the very image the runtime
 *   will run in — so it is admitted, sourced `image` rather than `curated` so the
 *   host-side admission gate stops asking for a probe it cannot make;
 * - package-launcher entries (`npx` / `uvx`), which fetch their artifact at launch:
 *   that artifact is not the image's, is not what the declared version pin names,
 *   and the fetch fails outright on a restricted egress. An image that ships such a
 *   runtime must resolve it to a pinned local executable in the catalog first.
 */
export function declaredRuntimeCatalog(catalog: ResolvedRuntimeCatalog, table: K8sRuntimeTable): DeclaredCatalogResult {
  const entries: ResolvedRuntimeCatalog['entries'] = {}
  const runtimes: ResolvedRuntimeCatalog['runtimes'] = {}
  const unresolved: string[] = []
  const rejectedCurated: string[] = []
  const rejectedPackageLaunchers: string[] = []
  const models: Record<string, string[]> = {}
  const acp: Record<string, K8sRuntimeAcpSnapshot> = {}

  for (const declared of table.runtimes) {
    const entry = catalog.entries[declared.id]
    if (!entry) {
      unresolved.push(declared.id)
      continue
    }
    const imageProbed = Boolean(declared.command && declared.acp)
    if (entry.source === 'curated' && !imageProbed) {
      rejectedCurated.push(declared.id)
      continue
    }
    // The image's own command wins. Checked AFTER that substitution: the registry distributes
    // both runtimes through `npx`, so rejecting on the registry's command would drop exactly the
    // runtimes the image installed as real executables — which is what forced operators to
    // restate them in daemon config.
    const runtime = declared.command
      ? { ...entry.runtime, command: declared.command, args: declared.args ?? [] }
      : entry.runtime
    if (PACKAGE_LAUNCHERS.has(runtime.command)) {
      rejectedPackageLaunchers.push(declared.id)
      continue
    }
    entries[declared.id] = {
      ...entry,
      runtime,
      ...(entry.source === 'curated' ? { source: 'image' as const } : {}),
      ...(declared.version ? { version: declared.version } : {})
    }
    runtimes[declared.id] = runtime
    if (declared.models?.length) models[declared.id] = [...declared.models]
    if (declared.acp) acp[declared.id] = declared.acp
  }

  return { catalog: { entries, runtimes }, unresolved, rejectedCurated, rejectedPackageLaunchers, models, acp }
}
