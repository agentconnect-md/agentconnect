import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { McpTransportCapabilities } from '@agentconnect.md/protocol'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { ModelOptions } from '../acp/acp-host.js'
import type { AcpProbeClient } from '../acp/probe-client.js'
import type { RuntimeDef } from '../config/config-schema.js'
import type { Logger } from '../log.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import { effectiveRunInSandbox, type PreparedRuntimeLaunch } from '../launch/prepare.js'
import { composeRuntimeLaunch } from '../launch/compose.js'
import { PACKAGE_LAUNCHERS } from './probe.js'
import { CLAUDE_MODEL_ALIAS_ENV } from './model-provider-config.js'

const PROCESS_ENV_KEYS = new Map([
  ['PATH', 'PATH'],
  ['PATHEXT', 'PATHEXT'],
  ['SYSTEMROOT', 'SystemRoot']
])
const CERTIFICATE_ENV_KEYS = new Set([
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  // A probe may fetch through git; the same operator bundle has to reach it (§24.5).
  'GIT_SSL_CAINFO'
])
const PROVIDER_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'KIRO_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  // The OpenClaw acp bridge's gateway connection overrides — credentials for a
  // host configured via env instead of ~/.openclaw/openclaw.json.
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_GATEWAY_PASSWORD',
  // Claude's alias→model declarations. A real launch inherits these from the host environment;
  // without them here the probe would read a picker the sessions do not have.
  ...CLAUDE_MODEL_ALIAS_ENV
])

/** Minimal ambient environment for an untrusted disposable compatibility probe. */
export function curatedProbeEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const processKey = PROCESS_ENV_KEYS.get(name.toUpperCase())
    if (processKey) {
      env[processKey] = value
      continue
    }
    if (CERTIFICATE_ENV_KEYS.has(name) || PROVIDER_ENV_KEYS.has(name) || /^(?:https?|all|no)_proxy$/i.test(name)) {
      env[name] = value
    }
  }
  return env
}

/** Shared no-op callbacks for disposable discovery sessions (probe + catalog
 *  enumeration): cancel permissions, decline elicitations, mute child stderr. */
export const probeCallbacks = {
  onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
  onElicit: async () => ({ action: 'decline' as const }),
  suppressChildStderr: true as const
}

export type ProbeHostPolicy = typeof probeCallbacks &
  Partial<Pick<PreparedRuntimeLaunch, 'env' | 'inheritProcessEnv' | 'sandbox'>>

/** Constructs the ACP client a probe drives — injected, so `runtimes/*` never names AcpHost. */
export type ProbeHostFactory = (rt: RuntimeDef, id: string, cwd: string, policy: ProbeHostPolicy) => AcpProbeClient

export interface ProbeLaunchPlan extends PreparedRuntimeLaunch {
  runtime?: RuntimeDef
  /** Transient private-state values that diagnostics must never expose. */
  redactValues?: string[]
}

/**
 * Runtime probing — actively verify each installed runtime is launchable and
 * learn the models it advertises.
 *
 * The ACP registry says a runtime *could* run here (a launcher/binary is on
 * `$PATH`), and the host probe (`probe.ts`) says it's plausibly installed. This
 * module goes one step further: it spawns the agent, runs the ACP `initialize`
 * handshake, opens a throwaway `session/new`, and reads the session's model
 * selector (an experimental ACP config option, `category: "model"`). Then it
 * tears the child down — killing the subprocess closes its in-memory session, so
 * no `session/close` round-trip is needed.
 *
 * This is deliberately kept off the connect hot path: the daemon runs it in the
 * background after (re)connecting to the CP and emits the results as one
 * `facts/daemon-runtimes` snapshot.
 */

export interface RuntimeProbeResult {
  runtime: string
  /** True iff the agent initialized and `session/new` succeeded. */
  ok: boolean
  /** Model ids advertised via the session's model selector (empty if none). */
  models: string[]
  /** The model the agent defaulted the session to, if it exposed a selector. */
  currentModel?: string
  /** ACP protocol version negotiated at `initialize` (undefined if the probe failed). */
  acpProtocolVersion?: number
  /** The agent's self-reported version from `initialize` (`agentInfo.version`) — the
   *  ACTUAL running adapter release (e.g. claude-agent-acp 0.59.0), as opposed to the
   *  registry's declared version. Undefined if the probe failed or the agent reported none. */
  probedVersion?: string
  /** Optional MCP transports advertised at `initialize` (stdio is baseline).
   *  Undefined if the probe failed — callers then assume stdio-only. */
  mcpCapabilities?: McpTransportCapabilities
  /** RAW session config options of the probe session (unaugmented, as the agent
   *  advertised them at `session/new`) — seeds the model-catalog cache with the
   *  default model's effort/fast caps and the runtime-level permission modes.
   *  Undefined when the probe failed or the host predates the accessor. */
  configOptions?: SessionConfigOption[]
  /** Failure reason when `ok` is false. */
  error?: string
  /** The probe was rejected with the ACP auth-required error (-32000): the agent
   *  launched and spoke ACP, but wants an interactive login before it will open
   *  a session. Only ever set alongside `ok: false`. */
  authRequired?: boolean
  /** The launch carried no provider credential although this runtime takes one (the cluster
   *  probe, on a deployment that configures neither key nor endpoint for it) — so a rejection
   *  says what the PROBE lacked, not that the runtime is logged out. */
  uncredentialed?: boolean
}

/** ACP reserves JSON-RPC -32000 for "authentication required" (the SDK's
 *  `RequestError.authRequired`) — the one failure that means "installed but
 *  logged out" rather than "broken/unreachable". Shared with the daemon's live
 *  dispatch path: some adapters (claude-agent-acp) initialize and open sessions
 *  while logged out and only reject the live prompt with this code. */
const ACP_AUTH_REQUIRED_CODE = -32000

export function isAuthRequiredError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ACP_AUTH_REQUIRED_CODE
}

export interface ProbeOptions {
  /** Per-runtime hard deadline (spawn + initialize + session/new). Default 30s. */
  timeoutMs?: number
  /** Max runtimes probed concurrently (each is a subprocess). Default 3. */
  concurrency?: number
  log?: Logger
  /** Constructs the probe client per runtime — `defaultProbeHostFactory()` in production. */
  hostFactory: ProbeHostFactory
  /** Called as each probe resolves, so a caller reports incrementally instead of
   *  at the sweep barrier — one slow runtime then delays only itself. */
  onResult?: (result: RuntimeProbeResult) => void
  /** Curated candidates require a disposable final managed launch plan. */
  curated?: boolean
  /** Full host environment used for allowlisted credential seeding and redaction. */
  hostEnv?: NodeJS.ProcessEnv
  runInSandbox?: boolean
  /** Operator policy: keeps an externalExecution runtime's probe sandboxed so it
   *  fails loudly instead of admitting a runtime that later refuses to launch. */
  requireSandbox?: boolean
  daemonRoot?: string
  agentsRoot?: string
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
  /** Prepare the same sandbox/private-HOME or inherited-host launch used by a real agent. */
  launchFor?: (
    id: string,
    rt: RuntimeDef,
    scopeDir: string,
    cwd: string,
    probeEnv: Record<string, string>
  ) => ProbeLaunchPlan
}

const DEFAULT_TIMEOUT_MS = 30_000
/** A package launcher builds its install tree on first use — measured at ~210s for a
 *  harness that pulls 700 packages — so its deadline only reaps a genuinely stuck
 *  child. Results are reported per probe (ProbeOptions.onResult), so a slow install no
 *  longer holds back the runtimes that already answered. */
const PACKAGE_LAUNCHER_TIMEOUT_MS = 6 * 60_000
const DEFAULT_CONCURRENCY = 3

/** Spawn + initialize + session/new budget for one runtime. */
export function probeTimeoutMs(rt: RuntimeDef): number {
  return PACKAGE_LAUNCHERS.has(rt.command) ? PACKAGE_LAUNCHER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

/** Probe temp roots are `ac-probe-<daemon-pid>-<random>` directly under the OS
 *  temp dir. The PID lets a sweeper distinguish a live concurrent daemon from
 *  a root whose owner has exited, without waiting for the legacy age cutoff. */
const LEGACY_PROBE_ROOT_PREFIX = 'ac-probe-'
const PROBE_ROOT_PREFIX = `${LEGACY_PROBE_ROOT_PREFIX}${process.pid}-`
const PID_PROBE_ROOT_PATTERN = /^ac-probe-(\d+)-/
/** Gaps between the observation points that follow a probe root's initial removal
 *  (see removeProbeRoot) — cumulatively 250ms, 1.25s and 4.25s after teardown. Every
 *  point is observed, but in the background, so none of it delays a probe result. */
const PROBE_ROOT_RECHECK_MS = [250, 1_000, 3_000]
/** How long a legacy root (created before PID-tagged names) may linger before
 *  {@link sweepStaleProbeRoots} treats it as abandoned. PID-tagged roots use
 *  process liveness instead, so they can be reclaimed promptly and without an
 *  arbitrary assumption about another daemon's maximum probe duration. */
const STALE_PROBE_ROOT_MS = 60 * 60_000

/** Probe roots this process is actively using. The recurring sweep skips them
 *  regardless of age, so it can never delete a root out from under a live sweep. */
const liveProbeRoots = new Set<string>()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function probeRootOwnerPid(name: string): number | undefined {
  const raw = PID_PROBE_ROOT_PATTERN.exec(name)?.[1]
  if (!raw) return undefined
  const pid = Number(raw)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** `kill(pid, 0)` performs an existence/permission check without sending a
 *  signal. EPERM still means the process exists (usually under another user). */
function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove one probe root, then keep watching so it STAYS removed.
 *
 * A runtime that escapes the adapter's process group can still be mid-write when
 * `stop()` resolves — omp registers its own daemon under the private HOME, so
 * `AcpHost.stop()`'s process-group SIGTERM/SIGKILL cannot reach it — and its next
 * write RE-CREATES the tree we just removed. So a single best-effort `rmSync` loses
 * the race and leaks the whole root, private runtime HOMEs included (~270MB once omp
 * has materialized its natives).
 *
 * "Gone right now" is no better a signal: the orphan's write may land after an earlier
 * check found the path clean, so stopping at the first empty stat would only move the
 * race window rather than close it. Every scheduled point is therefore observed, even
 * once the root looks gone.
 *
 * The first removal is synchronous, so a caller sees the root gone on return in the
 * ordinary case; the returned promise then completes the observation in the BACKGROUND
 * and is deliberately not awaited by {@link probeAllRuntimes}. Blocking every sweep on
 * the full window would tax all probing — and every test that probes — for a case that
 * usually never happens. If the process exits before the watch finishes, the root falls
 * to {@link sweepStaleProbeRoots}: the next startup, or the recurring idle sweep for a
 * daemon that keeps running.
 *
 * Never throws — a cleanup failure must not discard probe results we already have.
 */
function removeProbeRoot(root: string, log?: Logger): Promise<void> {
  let lastError: unknown
  const remove = (): void => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (err) {
      lastError = err
    }
  }

  remove()
  return (async () => {
    for (const delay of PROBE_ROOT_RECHECK_MS) {
      await sleep(delay)
      if (existsSync(root)) remove()
    }
    if (!existsSync(root) && !lastError) return
    const detail = existsSync(root) ? ' — it kept reappearing' : `: ${(lastError as Error).message}`
    log?.debug(`probe: temp cwd cleanup failed for ${root}${detail}`)
  })()
}

/**
 * Reclaim abandoned probe roots. `probeAllRuntimes` cleans up its own root, but a hard
 * kill mid-sweep — or a runtime that outlives every observation point in
 * {@link removeProbeRoot} — leaves one behind. Each can hold a private runtime HOME, so
 * a host accumulates them fast (269MB per omp probe), which is how a single busy hour
 * reached ~57GB of leaked roots.
 *
 * Called at daemon startup AND on the recurring idle sweep: a root re-created after the
 * last observation point must be reclaimable within the SAME long-lived process, not
 * only by the next restart. PID-tagged roots are removed as soon as their owner is this
 * process (but no longer live) or has exited. Roots this process is still using are
 * skipped outright (see {@link liveProbeRoots}), and roots owned by another live daemon
 * are preserved regardless of age.
 *
 * Best effort and never throws: a root owned by another user, or removed by a
 * concurrent daemon between the stat and the unlink, is skipped. Returns the number
 * of roots actually removed.
 */
export function sweepStaleProbeRoots(opts: { log?: Logger; maxAgeMs?: number; tmpRoot?: string } = {}): number {
  const tmpRoot = opts.tmpRoot ?? tmpdir()
  const cutoff = Date.now() - (opts.maxAgeMs ?? STALE_PROBE_ROOT_MS)
  let entries: string[]
  try {
    entries = readdirSync(tmpRoot)
  } catch (err) {
    opts.log?.debug(`probe: stale-root sweep could not read ${tmpRoot}: ${(err as Error).message}`)
    return 0
  }

  let removed = 0
  for (const name of entries) {
    if (!name.startsWith(LEGACY_PROBE_ROOT_PREFIX)) continue
    const path = join(tmpRoot, name)
    if (liveProbeRoots.has(path)) continue // a sweep in this process still owns it
    try {
      // lstat, never stat: the OS temp dir is world-writable, so a symlink planted
      // under our prefix must be skipped rather than followed out of the temp root.
      const stat = lstatSync(path)
      if (!stat.isDirectory()) continue
      const ownerPid = probeRootOwnerPid(name)
      if (ownerPid !== undefined) {
        // A current-process root not present in liveProbeRoots has completed and can
        // be removed immediately. A foreign root is safe to remove once its daemon
        // exits; while that daemon lives, never guess from directory timestamps.
        if (ownerPid !== process.pid && processIsAlive(ownerPid)) continue
      } else if (stat.mtimeMs > cutoff) {
        // Backward compatibility for roots created by versions without a PID tag.
        continue
      }
      rmSync(path, { recursive: true, force: true })
      removed++
    } catch (err) {
      opts.log?.debug(`probe: could not remove stale probe root ${path}: ${(err as Error).message}`)
    }
  }
  if (removed > 0) opts.log?.info(`probe: removed ${removed} stale probe temp root(s) under ${tmpRoot}`)
  return removed
}

function sanitizeProbeDiagnostic(error: unknown, env: NodeJS.ProcessEnv, privateValues: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error)
  const values = [...PROVIDER_ENV_KEYS].map((name) => env[name]).concat(privateValues)
  for (const value of values) {
    if (value && value.length >= 4) message = message.split(value).join('[REDACTED]')
  }
  message = message.replace(/(?:[A-Za-z]:\\|\/)[^\s'"`]+/g, '<path>')
  return message.replace(/[\r\n]+/g, ' ').slice(0, 512)
}

const MAX_REDACTION_VALUES = 256

function collectStringValues(value: unknown, out: Set<string>): void {
  if (out.size >= MAX_REDACTION_VALUES) return
  if (typeof value === 'string') {
    if (value.length >= 4 && value.length <= 256 * 1024) {
      out.add(value)
      try {
        collectStringValues(JSON.parse(value), out)
      } catch {
        // Plain credential string, not nested JSON.
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, out)
  }
}

function collectJsonCredentialValues(path: string, out: Set<string>): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) return
  try {
    collectStringValues(JSON.parse(readFileSync(path, 'utf8')), out)
  } catch {
    // Invalid auth state will be reported by the runtime; it is not safe input
    // for the probe process, but should not make diagnostic sanitization throw.
  }
}

function collectOmpCredentialValues(path: string, out: Set<string>): void {
  if (!existsSync(path)) return
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    for (const table of ['auth_credentials', 'auth_schema_version']) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all()
      for (const row of rows) collectStringValues(row, out)
    }
  } catch {
    // The runtime will surface an unusable private credential database itself.
  } finally {
    db?.close()
  }
}

/** Collect only values from reviewed credential seeds in the already-private
 * probe home. They remain transient and are never passed to the child policy. */
function collectDotEnvValues(path: string, out: Set<string>): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/)
    const value = match?.[1]?.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
    if (value) collectStringValues(value, out)
  }
}

function probeCredentialRedactions(id: string, launch: PreparedRuntimeLaunch): string[] {
  const out = new Set<string>()
  if (id === 'hermes-agent' || id === 'hermes') {
    const root = launch.env.HERMES_HOME
    if (root) {
      collectDotEnvValues(join(root, '.env'), out)
      collectJsonCredentialValues(join(root, '.anthropic_oauth.json'), out)
      collectJsonCredentialValues(join(root, 'auth.json'), out)
    }
  } else if (id === 'open-interpreter') {
    const root = launch.env.INTERPRETER_HOME
    if (root) collectJsonCredentialValues(join(root, 'auth.json'), out)
  } else if (id === 'omp') {
    const root = launch.env.PI_CODING_AGENT_DIR
    if (root) collectOmpCredentialValues(join(root, 'agent.db'), out)
  } else if (id === 'openclaw') {
    // Both seeded files can carry the local gateway auth token.
    const root = launch.env.OPENCLAW_STATE_DIR
    if (root) {
      collectJsonCredentialValues(join(root, 'openclaw.json'), out)
      collectDotEnvValues(join(root, '.env'), out)
    }
  }
  return [...out]
}

/** Hermes loads `.env` inside the child, after the spawn environment has been
 * filtered. Keep that seed from becoming a back door for credential-path or
 * unrelated ambient variables: only the reviewed scalar provider keys survive. */
function sanitizeHermesProbeDotEnv(launch: PreparedRuntimeLaunch): void {
  const hermesHome = launch.env.HERMES_HOME
  if (!hermesHome) return
  const path = join(hermesHome, '.env')
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('private Hermes .env is not a regular file')

  const kept: string[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (match && PROVIDER_ENV_KEYS.has(match[1]!)) kept.push(`${match[1]}=${match[2]}`)
  }
  writeFileSync(path, kept.length ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Maki's host config may declare MCP servers. A compatibility probe must not
 * connect to them, even though real protected launches retain reviewed config. */
function removeMakiProbeMcpConfig(launch: PreparedRuntimeLaunch): void {
  const home = launch.runtimeHome ?? launch.env.HOME
  if (!home) return
  for (const path of [join(home, '.config', 'maki', 'mcp.toml'), join(home, '.maki', 'mcp.toml')]) {
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('private Maki MCP config is not a regular file')
    unlinkSync(path)
  }
}

/** Build the disposable launch plan a probe/enumeration child runs under.
 *  `curated: true` composes the managed isolated-HOME plan (credential seeding +
 *  per-runtime sanitization); exported so the model-catalog enumerator launches
 *  through the exact same machinery. */
export function preparedProbeLaunch(
  id: string,
  runtime: RuntimeDef,
  cwd: string,
  opts: Omit<ProbeOptions, 'hostFactory'>
): ProbeLaunchPlan | undefined {
  const scopeDir = dirname(cwd)
  const sourceEnv = opts.hostEnv ?? process.env
  const probeEnv = curatedProbeEnvironment(sourceEnv)
  if (opts.launchFor) return opts.launchFor(id, runtime, scopeDir, cwd, probeEnv)
  if (!opts.curated) return undefined

  const composed = composeRuntimeLaunch({
    runtimeId: id,
    runtime,
    provider: 'managed',
    scopeDir,
    cwd,
    isolateHome: true,
    runInSandbox: effectiveRunInSandbox(
      opts.requireSandbox ?? false,
      opts.runInSandbox ?? false,
      opts.sandboxMechanism,
      runtime
    ),
    daemonRoot: opts.daemonRoot,
    agentsRoot: opts.agentsRoot,
    sandboxMechanism: opts.sandboxMechanism,
    mcpSocketPath: opts.mcpSocketPath,
    stateSourceEnv: sourceEnv,
    hostEnv: probeEnv,
    hostPackageCache: true
  })
  if (id === 'hermes-agent' || id === 'hermes') sanitizeHermesProbeDotEnv(composed.launch)
  if (id === 'maki') removeMakiProbeMcpConfig(composed.launch)
  return {
    runtime: composed.runtime,
    ...composed.launch,
    redactValues: probeCredentialRedactions(id, composed.launch)
  }
}

/**
 * Probe one runtime. Never throws: any failure (spawn error, handshake failure,
 * timeout) is captured in `{ ok: false, error }`. On success, `models` reflects
 * whatever the agent advertised — an empty list is normal for agents that expose
 * no model selector, and is not a failure.
 */
export async function probeRuntime(
  id: string,
  rt: RuntimeDef,
  cwd: string,
  opts: ProbeOptions
): Promise<RuntimeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? probeTimeoutMs(rt)
  let host: AcpProbeClient | undefined
  let redactValues: string[] = []

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    const launch = preparedProbeLaunch(id, rt, cwd, opts)
    redactValues = launch?.redactValues ?? []
    const effectiveRuntime = launch?.runtime ?? rt
    const hostPolicy: ProbeHostPolicy = {
      ...probeCallbacks,
      ...(launch
        ? {
            env: launch.env,
            inheritProcessEnv: launch.inheritProcessEnv,
            ...(launch.sandbox ? { sandbox: launch.sandbox } : {})
          }
        : {})
    }
    host = opts.hostFactory(effectiveRuntime, id, cwd, hostPolicy)
    const activeHost = host
    let probeSessionId: string | undefined
    const run = async (): Promise<ModelOptions | null> => {
      await activeHost.start()
      probeSessionId = await activeHost.newSession(cwd, [])
      return activeHost.modelOptions()
    }
    const opt = await Promise.race([run(), timeout])
    // Surface the model selector verbatim, including any literal "default" entry
    // the agent advertises (claude offers one, and it is the fresh-session
    // currentValue). We never SYNTHESIZE a "default" choice, but we mirror one the
    // runtime actually returns — the console picker no longer renders its own.
    const models = opt?.models ?? []
    const acpProtocolVersion = activeHost.acpProtocolVersion()
    // Optional calls: fake hosts in older tests may not implement the accessors.
    const mcpCapabilities = activeHost.mcpCapabilities?.() ?? undefined
    const info = activeHost.acpAgentInfo?.()
    const probedVersion = info?.version
    const configOptions =
      probeSessionId !== undefined ? (activeHost.sessionConfigOptions?.(probeSessionId) ?? undefined) : undefined
    opts.log?.info(
      `probe: ${id} ok (${info?.name ?? 'agent'}${info?.version ? ` v${info.version}` : ''}, models: ${models.length ? models.join(', ') : 'none advertised'})`
    )
    return {
      runtime: id,
      ok: true,
      models,
      currentModel: opt?.current,
      acpProtocolVersion,
      mcpCapabilities,
      probedVersion,
      configOptions
    }
  } catch (err) {
    const error = sanitizeProbeDiagnostic(err, opts.hostEnv ?? process.env, redactValues)
    opts.log?.warn(`probe: ${id} failed — ${error}`)
    return { runtime: id, ok: false, models: [], error, ...(isAuthRequiredError(err) ? { authRequired: true } : {}) }
  } finally {
    if (timer) clearTimeout(timer)
    await host?.stop().catch(() => {}) // best-effort teardown — never mask the probe result
  }
}

/**
 * Probe every runtime with bounded concurrency. Each gets an isolated scope with
 * `workspace/`; sandboxed probes also get a private runtime `home/`. The whole temp
 * root is removed after the sweep. Result order is not meaningful — callers key by
 * `result.runtime`.
 */
export async function probeAllRuntimes(
  runtimes: Record<string, RuntimeDef>,
  opts: ProbeOptions
): Promise<RuntimeProbeResult[]> {
  const ids = Object.keys(runtimes)
  if (ids.length === 0) return []

  const cwd = mkdtempSync(join(tmpdir(), PROBE_ROOT_PREFIX))
  // Claim the root so a concurrent recurring sweep cannot reclaim it mid-probe.
  liveProbeRoots.add(cwd)
  const limit = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const results: RuntimeProbeResult[] = []
  let next = 0

  const worker = async (): Promise<void> => {
    for (let i = next++; i < ids.length; i = next++) {
      const id = ids[i]!
      const runtimeDir = join(cwd, Buffer.from(id).toString('base64url'))
      const runtimeCwd = join(runtimeDir, 'workspace')
      mkdirSync(runtimeCwd, { recursive: true })
      const result = await probeRuntime(id, runtimes[id]!, runtimeCwd, opts)
      results.push(result)
      try {
        opts.onResult?.(result)
      } catch (err) {
        // A reporting failure must never abort the remaining probes.
        opts.log?.warn(`probe: reporting ${id} failed: ${(err as Error).message}`)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, () => worker()))
  } finally {
    // Best-effort cleanup — a temp-dir removal failure (e.g. Windows EBUSY, or a
    // runtime still writing from outside the adapter's process group) must never
    // discard the probe results we already gathered. The initial removal happens
    // synchronously inside removeProbeRoot; the observation window that follows it is
    // deliberately NOT awaited, so probe results are never held back by it. The claim
    // is released only when that watch ends, keeping the recurring sweep off this root
    // for its whole duration.
    void removeProbeRoot(cwd, opts.log).finally(() => liveProbeRoots.delete(cwd))
  }
  return results
}
