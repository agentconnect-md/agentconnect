/**
 * Daemon-private external-memory connection registry (M-5A).
 *
 * Connection definitions arrive independently from AgentSpec. Each definition
 * is conformance-probed through its selected transport before an external-memory
 * agent may start. Relay grants and local secret leases stay inside this
 * registry/client and are never copied into agent.json, runtime env, facts, or
 * logs.
 */
import { randomUUID } from 'node:crypto'
import {
  MEMORY_PLUGIN_TOOL,
  type MemoryConnectionFact,
  type MemoryConnectionSpec,
  type MemoryPluginManifest
} from '@agentconnect.md/protocol'
import {
  MemoryPluginClient,
  MemoryPluginManifestMismatchError,
  MemoryPluginProtocolError,
  assertMemoryConnectionConfig,
  type MemoryPluginClientOptions
} from '../memory-plugin/client.js'
import { recordMemoryPluginLifecycle } from '../memory-plugin/metrics.js'
import type { StdioMemoryPluginDef } from '../config/config-schema.js'

export type MemoryPluginConnector = (options: MemoryPluginClientOptions) => Promise<MemoryPluginClient>

interface Entry {
  spec: MemoryConnectionSpec
  fingerprint: string
  generation: number
  fact: MemoryConnectionFact
  client?: MemoryPluginClient
  probe?: Promise<void>
  retry?: ReturnType<typeof setTimeout>
}

export interface MemoryConnectionRegistryDeps {
  connect?: MemoryPluginConnector
  /** Operator-owned command allowlist. Control-plane definitions may reference
   * these keys but can never provide a command, arguments, or env targets. */
  stdioAllowlist?: Readonly<Record<string, StdioMemoryPluginDef>>
  /** Full, body-free snapshot after every state transition. */
  onFacts?: (facts: MemoryConnectionFact[]) => void
  /** Definition changed/vanished: callers fence hosts that captured its ABI. */
  onDefinitionChange?: (connectionId: string) => void
  /** Retry an initial transient probe failure. Tests use a short interval. */
  retryDelayMs?: number
}

class StaticConnectionError extends Error {
  constructor(readonly reasonCode: 'local_plugin_not_allowed' | 'secret_delivery_unavailable') {
    super(reasonCode)
    this.name = 'StaticConnectionError'
  }
}

function fingerprint(spec: MemoryConnectionSpec): string {
  // This string contains the relay grant or local secret lease and must never
  // be logged or surfaced.
  // It exists only to make reconnect snapshots idempotent while still detecting
  // a grant rotation that deliberately does not bump the connection revision.
  return JSON.stringify(spec)
}

function protocolFailure(error: unknown): boolean {
  return (
    error instanceof MemoryPluginProtocolError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'ZodError')
  )
}

function assertSecretContract(spec: MemoryConnectionSpec, manifest: MemoryPluginManifest): void {
  const reviewed = [...spec.pin.secretHeaders]
    .map((field) => ({ ...field, header: field.header.toLowerCase() }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const declared = manifest.connection.secretFields
    .map((field) => ({
      name: field.name,
      header: field.transportHeader?.toLowerCase() ?? '',
      required: field.required
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (
    reviewed.length !== declared.length ||
    reviewed.some(
      (field, index) =>
        field.name !== declared[index]?.name ||
        field.header !== declared[index]?.header ||
        field.required !== declared[index]?.required
    )
  ) {
    throw new MemoryPluginProtocolError('memory plugin secret contract does not match the installation pin')
  }
  const supplied = new Set(spec.secretKeys)
  if (
    supplied.size !== spec.secretKeys.length ||
    [...supplied].some((name) => !reviewed.some((f) => f.name === name))
  ) {
    throw new MemoryPluginProtocolError('memory plugin connection has unknown secret fields')
  }
  const missing = reviewed.filter((field) => field.required && !supplied.has(field.name))
  if (missing.length > 0) {
    throw new MemoryPluginProtocolError('memory plugin connection is missing required secret fields')
  }
}

function probingFact(spec: MemoryConnectionSpec): MemoryConnectionFact {
  return {
    connectionId: spec.connectionId,
    revision: spec.revision,
    pluginId: spec.pin.pluginId,
    status: 'probing'
  }
}

export class CpMemoryConnectionRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly connect: MemoryPluginConnector
  private generation = 0
  private closed = false

  constructor(private readonly deps: MemoryConnectionRegistryDeps = {}) {
    this.connect = deps.connect ?? ((options) => MemoryPluginClient.connect(options))
  }

  /** Full-replace the CP-owned set from register/ok. */
  converge(specs: readonly MemoryConnectionSpec[]): void {
    const desired = new Set(specs.map((spec) => spec.connectionId))
    for (const id of [...this.entries.keys()]) if (!desired.has(id)) this.remove(id)
    for (const spec of specs) this.upsert(spec)
  }

  /** Add/replace one definition and begin an asynchronous conformance probe. */
  upsert(spec: MemoryConnectionSpec): boolean {
    if (this.closed) return false
    const nextFingerprint = fingerprint(spec)
    const previous = this.entries.get(spec.connectionId)
    // CP mutations may commit in order but reach the daemon out of order (for
    // example across concurrent REST requests). Never roll a verified/newer
    // connection definition back. Every binding change, including grant
    // rotation, increments the durable revision; two different definitions at
    // one revision are equivocation and must fail closed rather than let the
    // last network arrival choose the credential/config.
    if (previous && spec.revision < previous.spec.revision) return false
    if (previous?.fingerprint === nextFingerprint) {
      // An acknowledged live upsert is also the CP's metadata resync barrier.
      // Re-emit the current body-free fact even when the definition is already
      // converged (notably after a daemon move commits placement in the DB).
      this.emitFacts()
      return true
    }
    if (previous?.spec.revision === spec.revision) {
      return false
    }

    const entry: Entry = {
      spec,
      fingerprint: nextFingerprint,
      generation: ++this.generation,
      fact: probingFact(spec)
    }
    this.entries.set(spec.connectionId, entry)
    if (previous?.retry) clearTimeout(previous.retry)
    if (previous?.client) void previous.client.close().catch(() => undefined)
    this.deps.onDefinitionChange?.(spec.connectionId)
    this.emitFacts()
    entry.probe = this.probe(entry)
    return true
  }

  remove(connectionId: string): void {
    const previous = this.entries.get(connectionId)
    if (!previous) return
    this.entries.delete(connectionId)
    if (previous.retry) clearTimeout(previous.retry)
    if (previous.client) void previous.client.close().catch(() => undefined)
    this.deps.onDefinitionChange?.(connectionId)
    this.emitFacts()
  }

  /** A verified client remains usable if a later per-turn call marks it degraded. */
  clientFor(connectionId: string): MemoryPluginClient | undefined {
    const entry = this.entries.get(connectionId)
    return entry?.client && (entry.fact.status === 'ready' || entry.fact.status === 'degraded')
      ? entry.client
      : undefined
  }

  specFor(connectionId: string): MemoryConnectionSpec | undefined {
    return this.entries.get(connectionId)?.spec
  }

  /** Static admission gate. Transient runtime degradation is allowed only after
   * a client completed conformance for this exact definition. */
  admissionError(connectionId: string): string | undefined {
    const entry = this.entries.get(connectionId)
    if (!entry) return 'external memory connection is not installed on this daemon'
    if (entry.client && (entry.fact.status === 'ready' || entry.fact.status === 'degraded')) return undefined
    if (entry.fact.status === 'probing') return 'external memory connection is still probing'
    if (entry.fact.status === 'invalid') return 'external memory connection failed conformance validation'
    return 'external memory connection is unavailable and has not completed validation'
  }

  /** Wait only for the current in-flight conformance probe. Used by the
   * acknowledged live upsert so a cold daemon move never races probing. */
  async waitForAdmission(connectionId: string, timeoutMs = 4_000): Promise<string | undefined> {
    const probe = this.entries.get(connectionId)?.probe
    if (!probe) return this.admissionError(connectionId)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      probe.then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
        timer.unref?.()
      })
    ])
    if (timer) clearTimeout(timer)
    return timedOut ? 'external memory connection probe timed out' : this.admissionError(connectionId)
  }

  /** Runtime call failures keep the already-validated client but surface a
   * metadata-only degraded fact. Never pass upstream error text as reasonCode. */
  markDegraded(connectionId: string, reasonCode = 'plugin_unavailable'): void {
    const entry = this.entries.get(connectionId)
    if (!entry?.client || entry.fact.status === 'invalid') return
    entry.fact = { ...entry.fact, status: 'degraded', reasonCode }
    this.emitFacts()
    // A local child cannot recover after an exit. Keep the already-validated
    // definition admission-open while a backoff probe replaces its client.
    if (entry.spec.transport === 'stdio') this.scheduleRetry(entry, true)
  }

  /** A runtime success recovers only the failure mode owned by that same
   * operation. Otherwise a records-page list/get can make a failed per-turn
   * recall look healthy even though recall has not run again. */
  markRecovered(connectionId: string, reasonCodes: readonly string[]): void {
    const entry = this.entries.get(connectionId)
    if (!entry?.client || entry.fact.status !== 'degraded' || !entry.fact.reasonCode) return
    if (!reasonCodes.includes(entry.fact.reasonCode)) return
    const { reasonCode: _reasonCode, ...fact } = entry.fact
    entry.fact = { ...fact, status: 'ready' }
    this.emitFacts()
  }

  facts(): MemoryConnectionFact[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.fact }))
      .sort((a, b) => a.connectionId.localeCompare(b.connectionId))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    for (const entry of entries) if (entry.retry) clearTimeout(entry.retry)
    await Promise.allSettled(entries.flatMap((entry) => (entry.client ? [entry.client.close()] : [])))
    await Promise.allSettled(entries.flatMap((entry) => (entry.probe ? [entry.probe] : [])))
  }

  private async probe(entry: Entry): Promise<void> {
    const replacingVerifiedStdio = entry.spec.transport === 'stdio' && !!entry.client
    let client: MemoryPluginClient | undefined
    try {
      const common = {
        expectedPluginId: entry.spec.pin.pluginId,
        expectedProfileMajor: entry.spec.pin.profileMajor,
        expectedManifestDigest: entry.spec.pin.manifestDigest
      }
      let options: MemoryPluginClientOptions
      if (entry.spec.transport === 'streamable-http') {
        options = {
          ...common,
          transport: 'streamable-http',
          url: entry.spec.relayUrl,
          headers: [{ name: 'Authorization', value: `Bearer ${entry.spec.grantKey}` }]
        }
      } else {
        const allowlist = this.deps.stdioAllowlist
        const definition =
          allowlist && Object.prototype.hasOwnProperty.call(allowlist, entry.spec.commandRef)
            ? allowlist[entry.spec.commandRef]
            : undefined
        if (!definition) throw new StaticConnectionError('local_plugin_not_allowed')
        // Use a null-prototype map for process env assembly. Logical secret
        // names and environment names are data, so names such as `constructor`
        // or `__proto__` must never resolve through/mutate Object.prototype.
        const environment: Record<string, string> = Object.create(null)
        for (const { name, value } of definition.env) environment[name] = value
        for (const [name, value] of Object.entries(entry.spec.secretLease.values)) {
          const target = Object.prototype.hasOwnProperty.call(definition.secretEnv, name)
            ? definition.secretEnv[name]
            : undefined
          if (!target) throw new StaticConnectionError('secret_delivery_unavailable')
          environment[target] = value
        }
        options = {
          ...common,
          transport: 'stdio',
          command: definition.command,
          args: definition.args,
          env: environment,
          onUnexpectedClose: () => {
            // Ignore callbacks from an old definition or a client deliberately
            // replaced/closed by this registry. A real child exit degrades the
            // validated definition and proactively starts the backoff cycle.
            queueMicrotask(() => {
              if (this.isCurrent(entry) && entry.client === client) {
                this.markDegraded(entry.spec.connectionId, 'plugin_process_exited')
              }
            })
          }
        }
      }
      client = await this.connect(options)
      assertSecretContract(entry.spec, client.manifest)
      assertMemoryConnectionConfig(entry.spec.config, client.manifest.connection.configSchema)
      if (!this.isCurrent(entry)) {
        await client.close().catch(() => undefined)
        return
      }
      let status: MemoryConnectionFact['status'] = 'ready'
      let reasonCode: string | undefined
      if (client.hasTool(MEMORY_PLUGIN_TOOL.health)) {
        try {
          const health = await client.health({
            context: {
              requestId: randomUUID(),
              connection: { id: entry.spec.connectionId, config: entry.spec.config },
              // Health is connection-scoped and body-free. Use a reserved probe
              // entity rather than impersonating a real agent binding.
              scope: { kind: 'agent', key: `ac:agent:probe-${entry.spec.connectionId}` }
            }
          })
          status = health.status
          // The plugin is outside our trust boundary. Never relay its arbitrary
          // diagnostic text to CP (it could echo an upstream credential); reduce
          // the verdict to one core-owned, body-free code.
          reasonCode = health.status === 'ready' ? undefined : `health_${health.status}`
        } catch (error) {
          // Malformed structured output is a static profile failure. A transport
          // timeout after conformance is transient: retain the verified client so
          // admission is fail-open and later per-turn calls can recover it.
          if (protocolFailure(error)) throw error
          status = 'degraded'
          reasonCode = 'health_unavailable'
        }
      }
      const fact: MemoryConnectionFact = {
        connectionId: entry.spec.connectionId,
        revision: entry.spec.revision,
        pluginId: client.manifest.plugin.id,
        version: client.manifest.plugin.version,
        profile: client.manifest.profile,
        manifestDigest: client.manifestDigest,
        capabilities: client.manifest.capabilities,
        ...(client.manifest.declaredEgressHosts ? { declaredEgressHosts: client.manifest.declaredEgressHosts } : {}),
        status,
        ...(reasonCode ? { reasonCode } : {})
      }
      if (status === 'invalid') {
        if (replacingVerifiedStdio) recordMemoryPluginLifecycle('stdio_restart_failed')
        await client.close().catch(() => undefined)
        client = undefined
        if (entry.client) await entry.client.close().catch(() => undefined)
        entry.client = undefined
      } else {
        const previous = entry.client
        entry.client = client
        if (previous && previous !== client) void previous.close().catch(() => undefined)
        if (replacingVerifiedStdio) recordMemoryPluginLifecycle('stdio_restart_succeeded')
      }
      entry.fact = fact
    } catch (error) {
      if (error instanceof MemoryPluginManifestMismatchError) recordMemoryPluginLifecycle('manifest_mismatch')
      if (replacingVerifiedStdio) recordMemoryPluginLifecycle('stdio_restart_failed')
      if (client) await client.close().catch(() => undefined)
      if (!this.isCurrent(entry)) return
      const staticFailure = error instanceof StaticConnectionError
      const invalid = staticFailure || protocolFailure(error)
      if (invalid && entry.client) {
        void entry.client.close().catch(() => undefined)
        entry.client = undefined
      }
      entry.fact = {
        ...probingFact(entry.spec),
        status: invalid ? 'invalid' : 'degraded',
        reasonCode: staticFailure ? error.reasonCode : invalid ? 'conformance_failed' : 'plugin_unavailable'
      }
      if (!invalid) this.scheduleRetry(entry, entry.spec.transport === 'stdio' && !!entry.client)
    }
    this.emitFacts()
  }

  /** A transient first probe has no validated client, so fail closed but retry
   * autonomously. Requiring a daemon/CP reconnect would otherwise strand the
   * connection forever after a short plugin outage. */
  private scheduleRetry(entry: Entry, replaceVerified = false): void {
    if (!this.isCurrent(entry) || entry.retry) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      if (!this.isCurrent(entry) || (!replaceVerified && entry.client)) return
      if (!replaceVerified) {
        entry.fact = probingFact(entry.spec)
        this.emitFacts()
      }
      if (replaceVerified) recordMemoryPluginLifecycle('stdio_restart_attempt')
      entry.probe = this.probe(entry)
    }, this.deps.retryDelayMs ?? 30_000)
    entry.retry.unref?.()
  }

  private isCurrent(entry: Entry): boolean {
    return !this.closed && this.entries.get(entry.spec.connectionId)?.generation === entry.generation
  }

  private emitFacts(): void {
    this.deps.onFacts?.(this.facts())
  }
}
