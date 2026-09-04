import type { Clock, TimerHandle } from '@agentconnect.md/connection'
import type {
  FactsMcpServer,
  FactsRuntimeProfile,
  McpTransportCapabilities,
  RuntimeModelCatalog
} from '@agentconnect.md/protocol'
import type { Logger } from '../log.js'
import type { RuntimeDef } from '../config/config-schema.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import type { LocalStore, RuntimeModelCapRecord } from '../store/local-store.js'
import type { ResolvedRuntimeCatalog } from './registry.js'
import type { CuratedRuntimeAdmission } from './curated-admission.js'
import type { K8sRuntimeAcpSnapshot } from './k8s-runtimes.js'
import { probeAllRuntimes, type ProbeOptions, type RuntimeProbeResult } from './runtime-prober.js'
import { defaultProbeHostFactory } from '../acp/probe-host-factory.js'
import { effectiveRunInSandbox, prepareRuntimeLaunch } from '../launch/prepare.js'
import { runtimeSandboxReadRoots } from '../launch/compose.js'
import { capsFromConfigOptions, augmentEffortOptions } from './config-caps.js'
import { isClaudeRuntimeDef } from '../runtime-defs/claude-runtime.js'
import { catalogFingerprint } from './model-catalog.js'
import { parseArchiveLaunch } from './archive-store.js'
import { mcpSocketPath } from '../paths.js'
import { formatErr } from '../daemon/text.js'

/** How long a completed probe sweep stays fresh — reconnects within this window
 *  re-emit the cached profiles instead of re-spawning every agent. Also the TTL
 *  curated admission measures a winner's freshness on. */
export const PROBE_TTL_MS = 5 * 60_000

/** The store rows the registry reads/writes — the last-good catalog cache. */
export type RuntimeFactsStore = Pick<
  LocalStore,
  | 'listRuntimeCatalogMetas'
  | 'listRuntimeModelCaps'
  | 'getRuntimeCatalogMeta'
  | 'recordRuntimeCatalogMeta'
  | 'upsertRuntimeModelCap'
>

/** How a sweep spawns: the injected seam, sandbox posture, and the roots a probe launch composes. */
export interface RuntimeProbeLaunchContext {
  /** `--k8s` runs no local probe — facts come from the image's declared table. */
  k8s: boolean
  /** Unit tests drive fake in-memory hosts; without an injected prober, don't spawn. */
  fakeHosts: boolean
  probe?: (runtimes: Record<string, RuntimeDef>, opts: ProbeOptions) => Promise<RuntimeProbeResult[]>
  sandboxMechanism?: SandboxMechanism
  /** Operator policy: an externalExecution runtime is then refused, not downgraded. */
  requireSandbox?: boolean
  daemonRoot: string
  agentsRoot: string | undefined
  isolateAccountApps: boolean
}

/** The genuinely outward calls the facts cluster makes: logging/clock, the catalog cache,
 *  the admitted-runtime view it projects over, CP egress, and how a probe launches. */
export interface RuntimeFactsHost {
  log(): Logger
  clock(): Clock
  store(): RuntimeFactsStore
  draining(): boolean
  catalog(): ResolvedRuntimeCatalog
  admittedRuntimes(): Record<string, RuntimeDef>
  refreshAdmitted(): void
  reportedRuntimeIds(): string[]
  curatedAdmission(): CuratedRuntimeAdmission
  emitDaemonRuntimes(profiles: FactsRuntimeProfile[], mcpServers: FactsMcpServer[]): void
  updateCapabilities(): void
  mcpServerFacts(): FactsMcpServer[]
  noteCatalogProbe(input: { runtimeId: string; rt: RuntimeDef; probedVersion?: string; models: string[] }): void
  /** Install a runtime's daemon-owned adapter, so the sweep probes what a session would launch. */
  localizeRuntime(runtimeId: string): Promise<void>
  launch(): RuntimeProbeLaunchContext
}

/**
 * Everything the daemon knows about the runtimes it can run: the per-runtime facts
 * (names, versions, models, ACP/MCP capabilities, login state, model catalogs), the
 * probe sweep that learns them, and the `facts/daemon-runtimes` snapshot it emits.
 *
 * One owner means one answer: `profileFor` is the single projection every
 * consumer reads, and a probed fact, a k8s-declared fact and a cache-hydrated one are
 * indistinguishable downstream because they all land in these maps.
 */
export class RuntimeFactsRegistry {
  private names: Record<string, string> = {} // registry id -> display name (for CP reporting)
  private versions: Record<string, string> = {} // registry id -> version (for the facts/daemon-runtimes snapshot)
  // Models learned by actively probing each runtime (registry id -> model ids).
  // Empty/absent until the post-connect probe sweep completes; feeds runtimeProfiles().
  private models = new Map<string, string[]>()
  // ACP protocol version each runtime negotiated at its last probe; feeds runtimeProfiles().
  private acpVersions = new Map<string, number>()
  // The agent's self-reported version (`agentInfo.version` from `initialize`) learned
  // at the last probe — the ACTUAL running adapter release (e.g. claude-agent-acp
  // 0.59.0). Preferred over the registry's declared version in profileFor().
  private probedVersions = new Map<string, string>()
  // MCP transports each runtime advertised at its last probe; feeds runtimeProfiles()
  // and gates which configured http/sse servers attach at session/new (absent ⇒ not
  // probed yet ⇒ assume stdio-only but attach optimistically — see resolve-servers.ts).
  private mcpCaps = new Map<string, McpTransportCapabilities>()
  // Provenance of `models` entries: 'cached' = hydrated from the local catalog cache
  // at boot (a live probe has not confirmed it this process) — the activation model
  // gate treats it as permissive; 'probed' = live result.
  private modelsSource = new Map<string, 'cached' | 'probed'>()
  // Runtimes whose last probe was rejected with the ACP auth-required error
  // (-32000): installed but needing an interactive login on this host. Feeds the
  // console's per-runtime login warning; cleared on any successful probe.
  private authRequired = new Set<string>()
  // Same signal observed on a LIVE turn (dispatch): kept separate from the
  // probe-derived set because a successful probe must not clear it —
  // claude-agent-acp initializes, opens sessions, and enumerates models fine
  // while logged out and only rejects the live prompt with -32000, so the probe
  // sweep is blind to its login state. Cleared by the next successful turn.
  private authRequiredLive = new Set<string>()
  // Report-shape model catalogs (last-good CAPABILITY knowledge, augmented for
  // reporting). Deliberately independent of the fail-to-empty rule that wipes
  // `models` (ADVERTISEMENT): a probe failure empties the offered list but keeps
  // the catalog, so the CP's capability data survives transient timeouts.
  private catalogs = new Map<string, RuntimeModelCatalog>()
  private probing = false // a probe sweep is in flight (dedup concurrent onReady fires)
  private ordinaryProbePending = false // a CP-ready sweep arrived behind a local curated sweep
  private curatedProbePending = false // a local TTL sweep arrived behind another sweep
  private lastProbeAtMs = 0 // when ordinary runtimes were last swept; gates re-probe on reconnect
  private probeTimer?: TimerHandle

  constructor(private readonly host: RuntimeFactsHost) {}

  /** Seed the declared name/version tables from the installed catalog (start-up). */
  setInstalled(entries: ResolvedRuntimeCatalog['entries']): void {
    this.names = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.name || id]))
    this.versions = Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.version]))
  }

  runtimeNames(): Record<string, string> {
    return this.names
  }

  offeredModels(runtimeId: string): string[] | undefined {
    return this.models.get(runtimeId)
  }

  /** Whether the offered list for a runtime is live probe knowledge (cache-hydrated is not). */
  offeredModelsAreLive(runtimeId: string): boolean {
    return this.modelsSource.get(runtimeId) !== 'cached'
  }

  mcpCapabilities(runtimeId: string): McpTransportCapabilities | undefined {
    return this.mcpCaps.get(runtimeId)
  }

  modelCatalog(runtimeId: string): RuntimeModelCatalog | undefined {
    return this.catalogs.get(runtimeId)
  }

  /** Build the current profile entry for a runtime (one element of the
   *  `facts/daemon-runtimes` snapshot), folding in any models learned by the
   *  probe sweep. */
  profileFor(id: string): FactsRuntimeProfile {
    return {
      runtime: id,
      // Prefer the probed adapter version (the actual running release, learned at the
      // last probe's `initialize`) over the registry's declared version; fall back to
      // the declared version when a runtime hasn't been probed / reported none.
      version: this.probedVersions.get(id) || this.versions[id] || '',
      models: this.models.get(id) ?? [],
      acpSupport: 'full',
      acpProtocolVersion: this.acpVersions.get(id),
      toolCalling: true,
      mcpCapabilities: this.mcpCaps.get(id),
      modelsSource: this.modelsSource.get(id),
      // Capability matrix rides every frame it exists for — including probe-failure
      // rounds where models[] empties (advertisement ≠ capability knowledge).
      modelCatalog: this.catalogs.get(id),
      ...(this.authRequired.has(id) || this.authRequiredLive.has(id) ? { authRequired: true } : {})
    }
  }

  /** The `facts/daemon-runtimes` snapshot for the currently reported runtime set. */
  emitFacts(): void {
    this.host.emitDaemonRuntimes(
      this.host.reportedRuntimeIds().map((id) => this.profileFor(id)),
      this.host.mcpServerFacts()
    )
  }

  /** Fold a live turn's auth outcome into the facts state. A turn rejected with
   *  ACP -32000 marks the agent's runtime login-required; a completed turn is
   *  the definitive "logged in" signal and clears both the live mark and any
   *  stale probe-derived one (the user logged in between sweeps). Re-emits the
   *  facts snapshot only when the reported flag actually flips. Called from the
   *  dispatch hot path (right after prompt / inside its failure handler), so
   *  the telemetry emit is best-effort like emitStoredUsageReport — it must
   *  never affect message delivery. */
  noteAuthFromTurn(runtimeId: string, authRequired: boolean): void {
    let changed: boolean
    if (authRequired) {
      changed = !this.authRequiredLive.has(runtimeId) && !this.authRequired.has(runtimeId)
      this.authRequiredLive.add(runtimeId)
    } else {
      changed = this.authRequiredLive.delete(runtimeId)
      if (this.authRequired.delete(runtimeId)) changed = true
    }
    if (!changed) return
    try {
      this.emitFacts()
    } catch (err) {
      this.host.log().debug(`runtime auth facts emit failed (${runtimeId}): ${(err as Error).message}`)
    }
  }

  /** Fold the declared/probed k8s snapshot into the SAME maps the profiles read, so a
   *  declared fact and a locally probed one are indistinguishable downstream. */
  applyDeclaredFacts(
    declaredModels: Record<string, string[]>,
    declaredAcp: Record<string, K8sRuntimeAcpSnapshot>
  ): void {
    for (const [runtimeId, models] of Object.entries(declaredModels)) {
      this.models.set(runtimeId, [...models])
      this.modelsSource.set(runtimeId, 'cached')
    }
    for (const [runtimeId, snapshot] of Object.entries(declaredAcp)) {
      if (snapshot.protocolVersion !== undefined) this.acpVersions.set(runtimeId, snapshot.protocolVersion)
      const mcp = snapshot.capabilities?.mcpCapabilities
      if (mcp && typeof mcp === 'object') {
        const caps = mcp as { http?: unknown; sse?: unknown }
        this.mcpCaps.set(runtimeId, { http: caps.http === true, sse: caps.sse === true })
      }
    }
  }

  /** The image's own probe answered: its catalog entries carry the versions the profile
   *  reports, which the declared table never does. */
  noteImageCatalog(entries: ResolvedRuntimeCatalog['entries']): void {
    for (const [id, entry] of Object.entries(entries)) {
      this.names[id] = entry.name
      if (entry.version) this.versions[id] = entry.version
      this.probedVersions.set(id, entry.version || (this.probedVersions.get(id) ?? ''))
    }
  }

  /** Synchronously pre-fill the in-memory runtime maps from the SQLite last-good
   *  catalog cache (design runtime-model-catalog.md §4): the register-time facts
   *  snapshot then carries cached models + matrix instead of an empty REPLACE
   *  that would wipe the CP's learned state until the sweep completes. Rows for
   *  runtimes not in the installed catalog are ignored (kept on disk — the
   *  runtime may only be temporarily unresolved); rows older than 30 days are
   *  garbage-collected. The store reads only this member's rows, so a member can
   *  never boot advertising models a peer's image runs and its own does not. */
  async hydrateFromCache(): Promise<void> {
    try {
      for (const meta of await this.host.store().listRuntimeCatalogMetas()) {
        if (!this.host.catalog().entries[meta.runtimeId]) continue
        await this.rebuildCatalog(meta.runtimeId)
        const cachedModels = (await this.host.store().listRuntimeModelCaps(meta.runtimeId)).map((r) => r.modelId)
        if (cachedModels.length > 0 && (this.models.get(meta.runtimeId) ?? []).length === 0) {
          this.models.set(meta.runtimeId, cachedModels)
          this.modelsSource.set(meta.runtimeId, 'cached')
        }
      }
    } catch (err) {
      this.host.log().warn(`catalog: cache hydrate failed: ${formatErr(err)}`)
    }
  }

  /** Rebuild one runtime's report-shape catalog from the cache: raw stored caps
   *  plus daemon-side synthetic effort levels (Claude max/ultracode) so the
   *  console vocabulary always matches the live-session pickers. */
  async rebuildCatalog(id: string): Promise<void> {
    const meta = await this.host.store().getRuntimeCatalogMeta(id)
    if (!meta) {
      this.catalogs.delete(id)
      return
    }
    const rt = this.host.catalog().entries[id]?.runtime
    const claude = rt ? isClaudeRuntimeDef(rt) : false
    const models = (await this.host.store().listRuntimeModelCaps(id)).map((r) => ({
      id: r.modelId,
      ...(r.caps.name ? { name: r.caps.name } : {}),
      ...(r.caps.description ? { description: r.caps.description } : {}),
      ...(r.caps.efforts !== undefined
        ? { efforts: claude ? augmentEffortOptions(r.caps.efforts) : r.caps.efforts }
        : {}),
      ...(r.caps.defaultEffort ? { defaultEffort: r.caps.defaultEffort } : {}),
      ...(r.caps.fastMode !== undefined ? { fastMode: r.caps.fastMode } : {})
    }))
    this.catalogs.set(id, {
      models: models.slice(0, 128),
      ...(meta.defaultModel ? { defaultModel: meta.defaultModel } : {}),
      ...(meta.permissionModes ? { permissionModes: meta.permissionModes } : {}),
      ...(meta.defaultPermissionMode ? { defaultPermissionMode: meta.defaultPermissionMode } : {}),
      source: meta.source,
      observedAt: new Date(meta.observedAt).toISOString()
    })
  }

  /** Admission freshness must not depend on CP reconnects: a CP-disabled or
   * continuously connected daemon rechecks curated winners on the same TTL. */
  armProbeRefresh(): void {
    if (this.host.draining() || this.probeTimer !== undefined) return
    if (!Object.values(this.host.catalog().entries).some((entry) => entry.source === 'curated')) return
    this.probeTimer = this.host.clock().setTimeout(() => {
      this.probeTimer = undefined
      if (this.host.draining()) return
      void this.probeAndEmit(false).finally(() => this.armProbeRefresh())
    }, PROBE_TTL_MS)
  }

  /** Drop the recurring curated re-probe timer so it cannot hold the process open. */
  dispose(): void {
    if (this.probeTimer !== undefined) {
      this.host.clock().clearTimeout(this.probeTimer)
      this.probeTimer = undefined
    }
  }

  /**
   * Probe every installed runtime in the background (launch → initialize →
   * session/new → read models → tear down), then emit one `facts/daemon-runtimes`
   * snapshot once the sweep completes so the CP replaces its runtime list. The
   * daemon-configured MCP-server list rides the same frame, derived from config
   * (no probing — see the host's `mcpServerFacts`).
   *
   * Triggered on each CP (re)connect. Deduped while in flight; skipped (with a
   * cached re-emit) when the last sweep is still fresh, so a reconnect storm can't
   * spawn a fleet of agent subprocesses. Never throws — probing is best-effort and
   * must not affect the CP connection.
   */
  async probeAndEmit(includeOrdinary = true): Promise<void> {
    const launch = this.host.launch()
    // --k8s has no runtime to launch on this host: profiles come from the image's
    // declared table. Still emit them, because this is also the CP (re)connect path
    // that (re)asserts the runtime list. Unconditional — unlike the fake-host guard
    // below, an injected prober must not re-enable local spawning in this mode.
    if (launch.k8s) {
      this.emitFacts()
      return
    }
    // With a hostFactory (unit tests use fake in-memory hosts) we don't spawn real
    // subprocesses unless a probe seam is injected.
    if (launch.fakeHosts && !launch.probe) return
    // Runtime probes are ACP children under the same UID. Sandbox-optional
    // principle (#36): probe sandboxed when a mechanism exists (launchFor below
    // sets runInSandbox from the sandbox mechanism), but still probe UNSANDBOXED
    // when none is available — otherwise curated runtimes are never admitted and
    // their agents cannot run on a no-sandbox host. The explicit operator
    // `security.requireSandbox` already refused boot without a mechanism.
    if (this.probing) {
      if (includeOrdinary) this.ordinaryProbePending = true
      else this.curatedProbePending = true
      return
    }

    const log = this.host.log()
    const catalog = this.host.catalog()
    const fresh = this.lastProbeAtMs > 0 && this.host.clock().now() - this.lastProbeAtMs < PROBE_TTL_MS
    const curatedCandidates = this.host.curatedAdmission().probeCandidates(catalog)
    if (fresh && Object.keys(curatedCandidates).length === 0) {
      // Recent results still valid — just re-assert the snapshot to the (new) connection.
      this.emitFacts()
      return
    }

    const ordinaryRuntimes =
      !includeOrdinary || fresh
        ? {}
        : Object.fromEntries(
            Object.entries(catalog.entries)
              .filter(([, entry]) => entry.source !== 'curated')
              .map(([id, entry]) => [id, entry.runtime])
          )
    const probeCount = Object.keys(ordinaryRuntimes).length + Object.keys(curatedCandidates).length
    if (probeCount === 0) return

    this.probing = true
    const probeIds = [...Object.keys(ordinaryRuntimes), ...Object.keys(curatedCandidates)]
    log.info(`probe: sweeping ${probeCount} runtime(s): ${probeIds.join(', ') || '(none)'}`)
    try {
      const probe = launch.probe ?? probeAllRuntimes
      const probeHostFactory = defaultProbeHostFactory({
        log,
        isolateAccountApps: launch.isolateAccountApps
      })
      // Apply and report every result the moment it lands. A package-launcher
      // runtime building its install tree takes minutes on first use, and holding
      // the whole sweep for it also held back the runtimes that answered in
      // seconds. `facts/daemon-runtimes` is idempotent REPLACE fenced by `seq`
      // (design runtime-model-catalog.md §6), so per-result frames converge.
      const applied = new Set<string>()
      const onResult = async (result: RuntimeProbeResult): Promise<void> => {
        if (applied.has(result.runtime)) return
        applied.add(result.runtime)
        await this.applyProbeResult(result)
        this.emitFacts()
      }
      const batches: Array<Promise<RuntimeProbeResult[]>> = []
      if (Object.keys(ordinaryRuntimes).length > 0) {
        batches.push(
          probe(ordinaryRuntimes, {
            log,
            hostFactory: probeHostFactory,
            onResult,
            // A vendor-archive runtime is not launchable until the store extracts it, and this sweep
            // is exactly what needs its model list — so install it inside its own probe slot rather
            // than at start-up or ahead of the batch. `parseArchiveLaunch` answers only for an entry
            // the store has not rewritten yet; a failed install drops the id from the catalog and is
            // reported where the install happened, so that runtime simply gets no probe.
            resolveRuntime: async (id, rt) => {
              const entry = catalog.entries[id]
              if (!entry || !parseArchiveLaunch(id, entry)) return rt
              log.info(`probe: installing the vendor archive for "${id}" before probing it`)
              await this.host.localizeRuntime(id)
              return this.host.catalog().entries[id]?.runtime
            },
            launchFor: (id, runtime, scopeDir, cwd) => {
              const runInSandbox = effectiveRunInSandbox(
                launch.requireSandbox ?? false,
                launch.sandboxMechanism !== undefined,
                launch.sandboxMechanism,
                runtime
              )
              return prepareRuntimeLaunch({
                runtimeId: id,
                runtime,
                scopeDir,
                cwd,
                runInSandbox,
                daemonRoot: launch.daemonRoot,
                agentsRoot: launch.agentsRoot,
                trustedRuntimeReadRoots: runInSandbox
                  ? runtimeSandboxReadRoots(runtime, process.env).readRoots
                  : undefined,
                explicitEnv: Object.fromEntries(runtime.env.map((entry) => [entry.name, entry.value])),
                sandboxMechanism: launch.sandboxMechanism,
                hostPackageCache: true
              })
            }
          })
        )
      }
      if (Object.keys(curatedCandidates).length > 0) {
        batches.push(
          probe(curatedCandidates, {
            curated: true,
            log,
            hostFactory: probeHostFactory,
            onResult,
            runInSandbox: launch.sandboxMechanism !== undefined,
            requireSandbox: launch.requireSandbox,
            daemonRoot: launch.daemonRoot,
            agentsRoot: launch.agentsRoot,
            sandboxMechanism: launch.sandboxMechanism,
            mcpSocketPath: mcpSocketPath(launch.daemonRoot),
            hostEnv: process.env
          })
        )
      }
      const results = (await Promise.all(batches)).flat()
      // An injected prober (tests) may not drive the incremental callback.
      for (const result of results) await onResult(result)
      if (Object.keys(ordinaryRuntimes).length > 0) this.lastProbeAtMs = this.host.clock().now()
      const okCount = results.filter((r) => r.ok).length
      log.info(`probe: sweep complete — ${okCount}/${results.length} runtime(s) reachable`)
      // Admission freshness is measured from the END of the sweep that observed it,
      // because armProbeRefresh() only starts the next one from here. Stamping
      // each result when it landed would expire a runtime that answered in seconds one
      // whole slow-launcher install before its next probe — unlaunchable, and pruned
      // from the snapshot — so restamp the batch now that every result is in.
      const reportedBefore = this.host.reportedRuntimeIds().join(' ')
      for (const result of results) {
        if (this.host.catalog().entries[result.runtime]?.source === 'curated') {
          this.host.curatedAdmission().record(result)
        }
      }
      this.host.refreshAdmitted()
      // Each result already emitted the REPLACE snapshot that prunes vanished ids, so
      // the CP is owed one only when the sweep produced none, or when restamping
      // brought a runtime back that had expired mid-sweep.
      if (applied.size === 0 || this.host.reportedRuntimeIds().join(' ') !== reportedBefore) {
        this.emitFacts()
      }
      // Probe results can change runtime-derived registration capabilities, and
      // register ran before this sweep — re-announce if the set moved.
      this.host.updateCapabilities()
    } catch (err) {
      log.warn(`probe: sweep failed: ${formatErr(err)}`)
    } finally {
      this.probing = false
      if (this.ordinaryProbePending || this.curatedProbePending) {
        const includePendingOrdinary = this.ordinaryProbePending
        this.ordinaryProbePending = false
        this.curatedProbePending = false
        void this.probeAndEmit(includePendingOrdinary)
      }
    }
  }

  /** Fold one result from the `--k8s` sandbox probe and re-assert the snapshot. Identical folding
   *  to a host sweep — the probe ran in a pod rather than beside the daemon, which is a fact about
   *  where the runtime lives, not about what its answer means. */
  async applySandboxProbe(result: RuntimeProbeResult): Promise<void> {
    // A pod probe that never reached the runtime says nothing ABOUT the runtime — the pod may have
    // been slow, or the channel may have dropped. The image's declared facts are still the best
    // knowledge this member has, and replacing them with an empty `probed` list would turn one
    // transient cluster failure into a strict model gate that refuses the agent. An auth-required
    // rejection is different: the runtime answered, and "logged out" is live knowledge.
    if (!result.ok && !result.authRequired) {
      this.host.log().warn(`probe: ${result.runtime} unreachable in the sandbox — keeping the image's declared facts`)
      return
    }
    // An auth-required rejection of a launch that carried no credential is the DEPLOYMENT's gap,
    // not a login this host is missing: publishing it would empty the model picker and ask the
    // user to log a cluster runtime in, on a machine nobody can log into.
    if (!result.ok && result.uncredentialed) {
      this.host
        .log()
        .warn(
          `probe: ${result.runtime} wants a provider credential and this deployment configures none — keeping the image's declared facts`
        )
      return
    }
    await this.applyProbeResult(result)
    this.emitFacts()
  }

  /** Fold one probe result into admission, advertised models/caps and the model
   *  catalog. Called per result so a slow runtime delays only itself. */
  private async applyProbeResult(r: RuntimeProbeResult): Promise<void> {
    if (this.host.catalog().entries[r.runtime]?.source === 'curated') this.host.curatedAdmission().record(r)
    this.host.refreshAdmitted()
    // Successful probes (including empty selectors) and auth failures are
    // authoritative. Preserve a non-empty cache-hydrated list across other
    // startup probe failures: disposable probe homes can fail while established
    // agent homes remain usable. Cached provenance keeps model gates permissive
    // until a later successful probe supplies live knowledge.
    const keepCachedAdvertisement =
      !r.ok &&
      !r.authRequired &&
      this.modelsSource.get(r.runtime) === 'cached' &&
      (this.models.get(r.runtime)?.length ?? 0) > 0
    if (!keepCachedAdvertisement) {
      this.models.set(r.runtime, r.ok ? r.models : [])
      this.modelsSource.set(r.runtime, 'probed')
    }
    if (r.ok && r.acpProtocolVersion !== undefined) this.acpVersions.set(r.runtime, r.acpProtocolVersion)
    else this.acpVersions.delete(r.runtime)
    if (r.ok && r.probedVersion) this.probedVersions.set(r.runtime, r.probedVersion)
    else this.probedVersions.delete(r.runtime)
    // Same overwrite rule: an unreachable runtime falls back to "not probed"
    // (⇒ session resolution turns optimistic again rather than trusting stale caps).
    if (r.ok && r.mcpCapabilities) this.mcpCaps.set(r.runtime, r.mcpCapabilities)
    else this.mcpCaps.delete(r.runtime)
    // Login state is live knowledge from this probe only: set on an ACP
    // auth-required rejection, cleared on success or any OTHER failure kind
    // (a timeout says nothing about credentials).
    if (!r.ok && r.authRequired) this.authRequired.add(r.runtime)
    else this.authRequired.delete(r.runtime)
    await this.seedCatalogFromProbe(r)
  }

  /** Phase 1 of catalog discovery (design runtime-model-catalog.md §3.3): the probe
   *  session's config options are already in hand — seed the cache with the default
   *  model's caps, every advertised model's display metadata, and the runtime-level
   *  permission modes, then let the discovery gate decide
   *  whether a full phase-2 discovery is due. A failed probe deliberately skips this:
   *  the last-good catalog is never cleared. */
  private async seedCatalogFromProbe(r: RuntimeProbeResult): Promise<void> {
    if (!r.ok) return
    const entry = this.host.catalog().entries[r.runtime]
    if (!entry || this.host.admittedRuntimes()[r.runtime] === undefined) return // curated candidates pre-admission stay out
    const store = this.host.store()
    try {
      const fp = catalogFingerprint(r.runtime, r.probedVersion, entry.runtime)
      if (r.configOptions) {
        const caps = capsFromConfigOptions(r.configOptions)
        const existing = await store.getRuntimeCatalogMeta(r.runtime)
        // Phase 1 must not flip a driver-built catalog back to 'acp'.
        const source = existing && existing.fingerprint === fp ? existing.source : 'acp'
        // The probe session sits on `currentModel` — which may be the literal
        // "default" a runtime advertises. Seed that model's caps under its real
        // id (so selecting "default" shows the runtime's own effort/fast), but
        // keep meta.defaultModel to a CONCRETE resolved id (never "default") —
        // it feeds the console's preselection + "Default (…)" hint, and a
        // native driver may still overwrite it with a concrete default.
        const seedModel = caps.currentModel
        const defaultModel = seedModel && seedModel !== 'default' ? seedModel : undefined
        await store.recordRuntimeCatalogMeta({
          runtimeId: r.runtime,
          fingerprint: fp,
          source,
          ...(defaultModel ? { defaultModel } : {}),
          ...(caps.permissionModes ? { permissionModes: caps.permissionModes } : {}),
          ...(caps.currentPermissionMode ? { defaultPermissionMode: caps.currentPermissionMode } : {}),
          observedAt: this.host.clock().now()
        })
        // Display metadata for EVERY advertised model is already in this one response, and a
        // --k8s member never runs the enumeration that would otherwise learn it — so seed the
        // whole picker's names/descriptions here, over a same-fingerprint row so an enumerated
        // matrix keeps its efforts.
        const known = new Map(
          (await store.listRuntimeModelCaps(r.runtime))
            .filter((row) => row.fingerprint === fp)
            .map((row) => [row.modelId, row.caps] as const)
        )
        const displayOf = (choice: { name?: string; description?: string }) => ({
          ...(choice.name ? { name: choice.name } : {}),
          ...(choice.description ? { description: choice.description } : {})
        })
        const rows = new Map<string, RuntimeModelCapRecord['caps']>()
        for (const choice of caps.modelChoices ?? []) {
          const display = displayOf(choice)
          if (Object.keys(display).length > 0) rows.set(choice.value, { ...known.get(choice.value), ...display })
        }
        // The seed model's own caps are authoritative for this fingerprint: merge only display
        // metadata under them, never a previous round's efforts.
        if (seedModel) {
          rows.set(seedModel, {
            ...displayOf(known.get(seedModel) ?? {}),
            ...displayOf(caps.modelChoices?.find((c) => c.value === seedModel) ?? {}),
            efforts: caps.efforts,
            ...(caps.defaultEffort ? { defaultEffort: caps.defaultEffort } : {}),
            fastMode: caps.fastMode
          })
        }
        const observedAt = this.host.clock().now()
        for (const [modelId, modelCaps] of rows) {
          await store.upsertRuntimeModelCap({
            runtimeId: r.runtime,
            modelId,
            fingerprint: fp,
            caps: modelCaps,
            observedAt
          })
        }
        await this.rebuildCatalog(r.runtime)
      }
      // Phase 2 enumerates model by model in an isolated HOME on THIS host, which `--k8s` does not
      // have: its runtimes live in a pod. A cluster probe therefore stops at the phase-1 seed
      // rather than scheduling a discovery that could only fail (or, for a native driver, run the
      // wrong machine's executable).
      if (!this.host.launch().k8s) {
        this.host.noteCatalogProbe({
          runtimeId: r.runtime,
          rt: entry.runtime,
          probedVersion: r.probedVersion,
          models: r.models
        })
      }
    } catch (err) {
      this.host.log().warn(`catalog: phase-1 seed for ${r.runtime} failed: ${formatErr(err)}`)
    }
  }
}
