import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeDef, Config } from '../config/config-schema.js'
import { registryPath, registryCachePath } from '../paths.js'
import { CURATED_RUNTIME_CATALOG } from './curated.js'
import { skillsAgentIdForRuntime } from './skills-capability.js'
import { MANAGED_RUNTIME_CATALOG } from './managed.js'

const PackageDistSchema = z.object({ package: z.string(), args: z.array(z.string()).default([]) })
const BinaryPlatformSchema = z.object({
  archive: z.string().optional(),
  cmd: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({})
})
const DistributionSchema = z.object({
  npx: PackageDistSchema.optional(),
  uvx: PackageDistSchema.optional(),
  binary: z.record(z.string(), BinaryPlatformSchema).optional()
})
export const RegistryEntrySchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  version: z.string().default(''),
  distribution: DistributionSchema
})
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

// Root tolerates both an id-keyed object and an {agents:[...]} array; normalizes to {agents: Record}.
export const RegistryDocSchema = z
  .object({ agents: z.union([z.array(RegistryEntrySchema), z.record(z.string(), RegistryEntrySchema)]) })
  .transform((d) => ({
    agents: Array.isArray(d.agents) ? Object.fromEntries(d.agents.map((a) => [a.id, a])) : d.agents
  }))
export type RegistryDoc = { agents: Record<string, RegistryEntry> }

// `image` is only ever stamped by the --k8s declared-table projection: a runtime the sandbox image
// installed and probed at build time, which is the admission evidence a host probe would gather.
export type RuntimeSource = 'curated' | 'registry' | 'managed' | 'user' | 'image'

export interface ResolvedRuntimeEntry {
  runtime: RuntimeDef
  source: RuntimeSource
  name: string
  version: string
  /** Audited skills CLI identity; absent means this harness has not passed the
   * skill-discovery compatibility admission. */
  skillsAgentId: string | null
  /** Vendor ZIP this platform's binary comes from; the store installs it and rewrites the command. */
  archive?: string
}

export interface ResolvedRuntimeCatalog {
  entries: Record<string, ResolvedRuntimeEntry>
  runtimes: Record<string, RuntimeDef>
}

export function platformKey(): string | null {
  const os =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'darwin'
        : process.platform === 'linux'
          ? 'linux'
          : null
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null
  if (!os || !arch) return null
  return `${os}-${arch}`
}

/** The archive this platform's binary is distributed in, when the entry names one. */
export function archiveUrl(entry: RegistryEntry): string | undefined {
  const key = platformKey()
  return (key ? entry.distribution.binary?.[key]?.archive : undefined) || undefined
}

export function toRuntimeDef(entry: RegistryEntry): RuntimeDef | null {
  const d = entry.distribution
  if (d.npx) return { command: 'npx', args: ['-y', d.npx.package, ...d.npx.args], env: [] }
  if (d.uvx) return { command: 'uvx', args: [d.uvx.package, ...d.uvx.args], env: [] }
  if (d.binary) {
    const key = platformKey()
    const bin = key ? d.binary[key] : undefined
    if (!bin) return null
    return { command: bin.cmd, args: bin.args, env: Object.entries(bin.env).map(([name, value]) => ({ name, value })) }
  }
  return null
}

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const DEFAULT_TIMEOUT_MS = 4500

interface CacheMeta {
  etag?: string
  lastModified?: string
  fetchedAt?: number
}

function readCachedDoc(root: string): RegistryDoc | null {
  const file = registryPath(root)
  if (!existsSync(file)) return null
  try {
    return RegistryDocSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function readCacheMeta(root: string): CacheMeta {
  const file = registryCachePath(root)
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CacheMeta
  } catch {
    return {}
  }
}

export async function fetchRegistry(
  root: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RegistryDoc> {
  const doFetch = opts.fetchImpl ?? fetch
  const meta = readCacheMeta(root)
  const headers: Record<string, string> = {}
  if (meta.etag) headers['If-None-Match'] = meta.etag
  if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await doFetch(REGISTRY_URL, { headers, signal: ac.signal })
    if (res.status === 304) return readCachedDoc(root) ?? { agents: {} }
    if (!res.ok) return readCachedDoc(root) ?? { agents: {} }
    const bodyText = await res.text()
    const doc = RegistryDocSchema.parse(JSON.parse(bodyText))
    mkdirSync(dirname(registryPath(root)), { recursive: true }) // root may not exist on a zero-config first run
    writeFileSync(registryPath(root), bodyText)
    const newMeta: CacheMeta = {
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
      fetchedAt: Date.now()
    }
    writeFileSync(registryCachePath(root), JSON.stringify(newMeta))
    return doc
  } catch {
    return readCachedDoc(root) ?? { agents: {} }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Display names (registry id -> human-facing `name`) read from the local cache.
 * Used for capability reporting — the daemon advertises the tool name to the CP
 * rather than the registry id. Entries with no `name` are omitted (callers fall
 * back to the id). Returns `{}` when no cached registry doc exists.
 */
export function cachedRuntimeNames(root: string): Record<string, string> {
  const doc = readCachedDoc(root)
  if (!doc) return {}
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(doc.agents)) {
    if (entry.name) out[id] = entry.name
  }
  return out
}

/**
 * Runtime versions (registry id -> `version`) read from the local cache. Used to
 * stamp each entry of the `facts/daemon-runtimes` snapshot the daemon reports.
 * Entries with no `version` are omitted (callers fall back to ''). `{}` when no
 * cached registry doc exists.
 */
export function cachedRuntimeVersions(root: string): Record<string, string> {
  const doc = readCachedDoc(root)
  if (!doc) return {}
  const out: Record<string, string> = {}
  for (const [id, entry] of Object.entries(doc.agents)) {
    if (entry.version) out[id] = entry.version
  }
  return out
}

export async function defaultRuntimes(
  root: string,
  opts: { mode?: 'cache-first' | 'blocking'; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<Record<string, RuntimeDef>> {
  const mode = opts.mode ?? 'blocking'
  const cached = mode === 'cache-first' ? readCachedDoc(root) : null
  let doc: RegistryDoc
  if (cached) {
    doc = cached
    void fetchRegistry(root, opts).catch(() => {}) // background refresh; affects next run only
  } else {
    doc = await fetchRegistry(root, opts)
  }
  const out: Record<string, RuntimeDef> = {}
  for (const [id, entry] of Object.entries(doc.agents)) {
    const rt = toRuntimeDef(entry)
    if (rt) out[id] = rt
  }
  return out
}

async function registryDocForResolution(
  root: string,
  opts: { mode?: 'cache-first' | 'blocking'; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<RegistryDoc> {
  const mode = opts.mode ?? 'blocking'
  const cached = mode === 'cache-first' ? readCachedDoc(root) : null
  if (!cached) return fetchRegistry(root, opts)
  void fetchRegistry(root, opts).catch(() => {})
  return cached
}

function runtimeMap(entries: Record<string, ResolvedRuntimeEntry>): Record<string, RuntimeDef> {
  return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.runtime]))
}

/** Resolve curated, usable registry, AgentConnect-managed, and explicit user
 * definitions with source metadata. Later layers take precedence. */
export async function resolveRuntimeCatalog(
  cfg: Config,
  root: string,
  opts: {
    neededRuntimes?: string[]
    mode?: 'cache-first' | 'blocking'
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {}
): Promise<ResolvedRuntimeCatalog> {
  const entries: Record<string, ResolvedRuntimeEntry> = Object.fromEntries(
    Object.entries(CURATED_RUNTIME_CATALOG).map(([id, entry]) => [
      id,
      resolvedRuntimeEntry(id, entry.runtime, 'curated', entry.name, '')
    ])
  )
  const userRuntimes = cfg.runtimes ?? {}
  const needed = opts.neededRuntimes
  const localCoversNeeded =
    needed && needed.length > 0 && needed.every((id) => userRuntimes[id] || MANAGED_RUNTIME_CATALOG[id])
  const registry = localCoversNeeded
    ? (readCachedDoc(root) ?? { agents: {} })
    : await registryDocForResolution(root, opts)

  for (const [id, entry] of Object.entries(registry.agents)) {
    const runtime = toRuntimeDef(entry)
    if (!runtime) continue
    entries[id] = resolvedRuntimeEntry(id, runtime, 'registry', entry.name || id, entry.version, archiveUrl(entry))
  }
  for (const [id, entry] of Object.entries(MANAGED_RUNTIME_CATALOG)) {
    entries[id] = resolvedRuntimeEntry(id, entry.runtime, 'managed', entry.name, entry.version)
  }
  for (const [id, runtime] of Object.entries(userRuntimes)) {
    entries[id] = resolvedRuntimeEntry(id, runtime, 'user', id, '')
  }

  // The legacy explicit id is an operator override for the canonical automatic
  // Hermes entry. Keep both only when the operator explicitly configured both.
  if (userRuntimes.hermes && !userRuntimes['hermes-agent']) delete entries['hermes-agent']

  return { entries, runtimes: runtimeMap(entries) }
}

function resolvedRuntimeEntry(
  id: string,
  runtime: RuntimeDef,
  source: RuntimeSource,
  name: string,
  version: string,
  archive?: string
): ResolvedRuntimeEntry {
  // A user runtime overrides the command/args as well as the id's semantics.
  // Never inherit an audited built-in capability from the reused id: operators
  // must explicitly admit their replacement harness with skillsAgentId.
  const skillsAgentId =
    source === 'user' && !Object.prototype.hasOwnProperty.call(runtime, 'skillsAgentId')
      ? undefined
      : skillsAgentIdForRuntime(id, runtime)
  return { runtime, source, name, version, skillsAgentId: skillsAgentId ?? null, ...(archive ? { archive } : {}) }
}

export async function resolveRuntimes(
  cfg: Config,
  root: string,
  opts: {
    neededRuntimes?: string[]
    mode?: 'cache-first' | 'blocking'
    fetchImpl?: typeof fetch
    timeoutMs?: number
  } = {}
): Promise<Record<string, RuntimeDef>> {
  return (await resolveRuntimeCatalog(cfg, root, opts)).runtimes
}
