import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { McpStdioServer } from '../mcp/inject.js'
import type {
  RegisterSessionMcpCell,
  ReleaseSessionMcpCell,
  SessionMcpBridgeDisconnected,
  SessionMcpBroker,
  SessionMcpCellMount
} from '../mcp/session-mcp-broker.js'
import type { AcpHost, AcpSandboxLaunch } from './acp-host.js'

type BrokerPort = Pick<
  SessionMcpBroker,
  'registerCell' | 'getCellMount' | 'beginDrainCell' | 'releaseCell' | 'subscribeBridgeDisconnect'
>

export type StartDelegatedWebchatHost = Omit<RegisterSessionMcpCell, 'isolationCellId' | 'platform'>

export interface DelegatedWebchatHostFactoryInput {
  agentId: string
  conversationId: string
  runtimeHome: string
  adminMcpServer: McpStdioServer
  sandbox: AcpSandboxLaunch & { mechanism: 'bwrap' }
  onTerminal: () => void
}

export interface DelegatedWebchatHost {
  isolationCellId: string
  host: AcpHost
  runtimeHome: string
  adminMcpServer: McpStdioServer
  mount: SessionMcpCellMount
}

type CleanupSource = 'startup' | 'manager_stop' | 'explicit_stop' | 'bridge_disconnect' | 'host_terminal'
type CleanupStep = 'broker_drain' | 'host_stop' | 'broker_release' | 'home_remove'

export interface DelegatedHostCleanupError {
  source: CleanupSource
  step: CleanupStep
  retryable: true
}

interface CellRecord extends ReleaseSessionMcpCell {
  key: string
  expiresAt: string
  runtimeHome: string
  host?: AcpHost
  adminMcpServer?: McpStdioServer
  mount?: SessionMcpCellMount
  registered: boolean
  registrationSettled: boolean
  /** The raw broker registration, not the cancellation race exposed to startHost.
   * Teardown must await this exact operation before deciding whether a cell exists. */
  registration?: ReturnType<BrokerPort['registerCell']>
  hostCreationSettled: boolean
  allocationSettled: boolean
  drained: boolean
  hostStopped: boolean
  released: boolean
  homeRemoved: boolean
  teardown?: Promise<void>
}

interface PendingStart {
  authority: StartDelegatedWebchatHost
  cancelled: boolean
  cancelSignal: Promise<void>
  cancel: () => void
  record?: CellRecord
  promise: Promise<DelegatedWebchatHost>
}

export interface DelegatedWebchatHostManagerDeps {
  broker: BrokerPort
  /** Common daemon-owned source root masked from every untrusted ACP process. */
  brokerSourceRoot: string
  /** Trusted parent for conversation-private runtime homes. */
  runtimeHomeRoot: string
  /** Live probe result: enforced Linux bwrap with PID/mount isolation. */
  isolationHealthy: () => boolean
  hostFactory: (input: DelegatedWebchatHostFactoryInput) => AcpHost
  randomCellId?: () => string
  removeRuntimeHome?: (path: string) => Promise<void>
  onCleanupError?: (event: DelegatedHostCleanupError) => void
  log?: { warn(message: string): void }
}

function logicalKey(input: { agentId: string; conversationId: string }): string {
  return JSON.stringify([input.agentId, input.conversationId])
}

function sameAuthority(a: StartDelegatedWebchatHost, b: StartDelegatedWebchatHost): boolean {
  return (
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId &&
    a.delegationId === b.delegationId &&
    a.generation === b.generation &&
    a.expiresAt === b.expiresAt
  )
}

function sameFence(a: ReleaseSessionMcpCell, b: ReleaseSessionMcpCell): boolean {
  return (
    a.isolationCellId === b.isolationCellId &&
    a.agentId === b.agentId &&
    a.conversationId === b.conversationId &&
    a.delegationId === b.delegationId &&
    a.generation === b.generation
  )
}

function strictlyInside(root: string, child: string): boolean {
  return resolve(child).startsWith(resolve(root) + sep)
}

/**
 * Owns one fresh ACP process and kernel-isolation cell per entitled logical
 * webchat conversation. Delegation authority stays in this trusted daemon
 * layer; the child receives only its private descriptor and bind mount.
 */
export class DelegatedWebchatHostManager {
  private readonly active = new Map<string, CellRecord>()
  private readonly draining = new Map<string, CellRecord>()
  private readonly pending = new Map<string, PendingStart>()
  /** Authority metadata retained after non-revoking local cleanup so a later
   * logical TTL close or agent detach can still revoke the exact generation.
   * Logical-key deduplication, expiry pruning, and the broker's bounded
   * conversation-fence history keep this metadata-only ledger bounded. */
  private readonly inactiveAuthorities = new Map<string, StartDelegatedWebchatHost>()
  private readonly unsubscribeBridgeDisconnect: () => void
  private stopped = false

  constructor(private readonly deps: DelegatedWebchatHostManagerDeps) {
    if (!deps.isolationHealthy()) {
      throw new Error('delegated webchat isolation is unavailable')
    }
    // Subscribe before any host can start and open its cell-local bridge.
    this.unsubscribeBridgeDisconnect = deps.broker.subscribeBridgeDisconnect((event) => {
      void this.onBridgeDisconnect(event).catch(() => {
        // onBridgeDisconnect reports classified failures itself. This terminal
        // catch prevents an observer rejection from becoming process-global.
      })
    })
  }

  async startHost(input: StartDelegatedWebchatHost): Promise<DelegatedWebchatHost> {
    this.assertCanStart()
    this.pruneInactiveAuthorities()
    const key = logicalKey(input)
    const currentPending = this.pending.get(key)
    if (currentPending) {
      if (!sameAuthority(currentPending.authority, input)) {
        throw new Error(`conversation ${input.conversationId} is already starting with different authority`)
      }
      return currentPending.promise
    }
    const active = this.active.get(key)
    if (active) {
      if (!sameAuthority(active, input)) {
        if (input.generation <= active.generation) {
          throw new Error(`stale delegation generation ${input.generation}; active generation is ${active.generation}`)
        }
        // Replacement is deliberately drain-first. The broker keeps the old
        // immutable fence until its listener and host are gone, so a failed
        // replacement can never restore or overlap stale authority.
        await this.teardown(active, 'explicit_stop')
        return this.startHost(input)
      }
      return this.publicHost(active)
    }
    if (this.draining.has(key)) {
      throw new Error(`conversation ${input.conversationId} is still draining`)
    }

    let cancel!: () => void
    const pending: PendingStart = {
      authority: input,
      cancelled: false,
      cancelSignal: new Promise<void>((resolveCancel) => {
        cancel = resolveCancel
      }),
      cancel: () => {
        if (pending.cancelled) return
        pending.cancelled = true
        cancel()
      },
      promise: undefined as unknown as Promise<DelegatedWebchatHost>
    }
    const allocation = this.allocateAndStart(input, key, pending)
    pending.promise = allocation
    this.pending.set(key, pending)
    void allocation
      .finally(() => {
        const current = this.pending.get(key)
        if (current === pending) this.pending.delete(key)
      })
      .catch(() => undefined)
    return allocation
  }

  async stopHost(input: { agentId: string; conversationId: string; isolationCellId: string }): Promise<boolean> {
    const key = logicalKey(input)
    const record = this.active.get(key) ?? this.draining.get(key)
    if (!record || record.isolationCellId !== input.isolationCellId) return false
    await this.teardown(record, 'explicit_stop')
    return true
  }

  /** Local lifecycle cleanup for one conversation. Unlike closeConversation this
   * deliberately retains the immutable authority for later TTL/detach revocation. */
  async stopConversationHosts(input: { agentId: string; conversationId: string }): Promise<void> {
    const stopped = await this.stopMatching(
      (record) => record.agentId === input.agentId && record.conversationId === input.conversationId,
      'explicit_stop'
    )
    this.retainInactiveAuthorities(stopped)
  }

  /** Tear down one logical conversation and return the immutable authority that
   * the daemon may revoke at the CP. Browser transport close never calls this. */
  async closeConversation(input: {
    agentId: string
    conversationId: string
  }): Promise<StartDelegatedWebchatHost | null> {
    const key = logicalKey(input)
    const pending = this.pending.get(key)
    const selected = this.active.get(key) ?? this.draining.get(key) ?? pending?.record
    if (pending) {
      pending.cancel()
      await pending.promise.catch(() => undefined)
    }
    const record = selected ?? this.active.get(key) ?? this.draining.get(key) ?? pending?.record
    const authority = record ? this.authority(record) : (this.inactiveAuthorities.get(key) ?? null)
    if (record) await this.teardown(record, 'explicit_stop')
    this.inactiveAuthorities.delete(key)
    return authority
  }

  /** Agent detach is a real authority boundary: remove every private cell and
   * hand their exact generation fences back to the daemon for CP revocation. */
  async closeAgent(agentId: string): Promise<StartDelegatedWebchatHost[]> {
    this.pruneInactiveAuthorities()
    const closed = await this.stopMatching((record) => record.agentId === agentId, 'explicit_stop')
    const authorities = new Map(closed.map((authority) => [logicalKey(authority), authority]))
    for (const [key, authority] of this.inactiveAuthorities) {
      if (authority.agentId !== agentId) continue
      authorities.set(key, authority)
      this.inactiveAuthorities.delete(key)
    }
    return [...authorities.values()]
  }

  /** Stop every private process for one agent without changing the manager's
   * ability to start a fresh cell later. Lifecycle drains use this local cleanup
   * boundary without revoking the CP delegation authority. */
  async stopAgentHosts(agentId: string): Promise<void> {
    const stopped = await this.stopMatching((record) => record.agentId === agentId, 'explicit_stop')
    this.retainInactiveAuthorities(stopped)
  }

  /** Local daemon-drain counterpart of stopAgentHosts. Unlike stop(), this keeps
   * the manager subscribed and available after a rebalance re-opens admission. */
  async stopAllHosts(): Promise<void> {
    const stopped = await this.stopMatching(() => true, 'explicit_stop')
    this.retainInactiveAuthorities(stopped)
  }

  /** Manager shutdown is local cell teardown only. The owning daemon calls
   * SessionMcpBroker.stop() exactly once at its own terminal boundary. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.unsubscribeBridgeDisconnect()
    }
    this.inactiveAuthorities.clear()
    const pending = [...this.pending.values()]
    for (const start of pending) start.cancel()
    await Promise.all(pending.map((start) => start.promise.catch(() => undefined)))
    const records = new Set<CellRecord>([
      ...this.active.values(),
      ...this.draining.values(),
      ...pending.flatMap((start) => (start.record ? [start.record] : []))
    ])
    const attempts = await Promise.allSettled([...records].map((record) => this.teardown(record, 'manager_stop')))
    const failures = attempts.flatMap((attempt) => (attempt.status === 'rejected' ? [attempt.reason] : []))
    // A cancelled pending allocation may finish its startup teardown after the
    // initial clear above; terminal manager shutdown never retains authority.
    this.inactiveAuthorities.clear()
    if (failures.length) throw new AggregateError(failures, 'delegated webchat cleanup incomplete')
  }

  debugStats(): {
    activeHosts: number
    pendingStarts: number
    drainingHosts: number
    inactiveAuthorities: number
    stopped: boolean
  } {
    this.pruneInactiveAuthorities()
    return {
      activeHosts: this.active.size,
      pendingStarts: this.pending.size,
      drainingHosts: this.draining.size,
      inactiveAuthorities: this.inactiveAuthorities.size,
      stopped: this.stopped
    }
  }

  private async allocateAndStart(
    input: StartDelegatedWebchatHost,
    key: string,
    pending: PendingStart
  ): Promise<DelegatedWebchatHost> {
    const isolationCellId = this.deps.randomCellId?.() ?? randomUUID()
    const runtimeHome = await this.createRuntimeHome()
    const record: CellRecord = {
      key,
      isolationCellId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      delegationId: input.delegationId,
      generation: input.generation,
      expiresAt: input.expiresAt,
      runtimeHome,
      registered: false,
      registrationSettled: false,
      hostCreationSettled: false,
      allocationSettled: false,
      drained: false,
      hostStopped: false,
      released: false,
      homeRemoved: false
    }
    pending.record = record
    try {
      this.assertPendingCanStart(pending)
      const registration: RegisterSessionMcpCell = {
        isolationCellId,
        platform: 'webchat',
        ...input
      }
      const registrationTask = this.deps.broker.registerCell(registration).then(
        (adminMcpServer) => {
          record.registrationSettled = true
          if (adminMcpServer) {
            record.registered = true
            record.adminMcpServer = adminMcpServer
          }
          if (pending.cancelled) void this.teardown(record, 'startup').catch(() => undefined)
          return adminMcpServer
        },
        (error) => {
          record.registrationSettled = true
          if (pending.cancelled) void this.teardown(record, 'startup').catch(() => undefined)
          throw error
        }
      )
      record.registration = registrationTask
      const adminMcpServer = await this.raceCancellation(registrationTask, pending)
      if (!adminMcpServer) throw new Error('delegated webchat broker refused the isolation cell')
      this.assertPendingCanStart(pending)
      const mount = this.deps.broker.getCellMount(isolationCellId)
      if (!mount || !strictlyInside(this.deps.brokerSourceRoot, mount.sourceDirectory)) {
        throw new Error('delegated webchat broker returned an invalid cell mount')
      }

      const onTerminal = () => {
        void this.teardown(record, 'host_terminal').catch(() => undefined)
      }
      const host = this.deps.hostFactory({
        agentId: input.agentId,
        conversationId: input.conversationId,
        runtimeHome,
        adminMcpServer,
        sandbox: {
          mechanism: 'bwrap',
          writable: [runtimeHome],
          maskedReadRoots: [this.deps.brokerSourceRoot, this.deps.runtimeHomeRoot],
          delegatedCellMount: {
            maskedRoot: this.deps.brokerSourceRoot,
            sourceDir: mount.sourceDirectory,
            targetDir: mount.targetDirectory
          },
          delegatedRuntimeHomeMount: {
            maskedRoot: this.deps.runtimeHomeRoot,
            sourceDir: runtimeHome,
            targetDir: runtimeHome
          }
        },
        onTerminal
      })
      record.host = host
      record.mount = mount
      record.hostCreationSettled = true
      this.assertPendingCanStart(pending)
      this.active.set(key, record)
      const hostStart = Promise.resolve().then(() => host.start())
      await this.raceCancellation(hostStart, pending)
      if (
        this.stopped ||
        pending.cancelled ||
        !this.deps.isolationHealthy() ||
        this.active.get(key) !== record ||
        record.teardown
      ) {
        throw new Error('delegated webchat host terminated during startup')
      }
      this.inactiveAuthorities.delete(key)
      return this.publicHost(record)
    } catch (error) {
      record.hostCreationSettled = true
      await this.teardown(record, 'startup').catch(() => undefined)
      throw error
    } finally {
      record.allocationSettled = true
      if (pending.cancelled || this.draining.get(key) === record) {
        await this.teardown(record, 'startup').catch(() => undefined)
      }
    }
  }

  private async createRuntimeHome(): Promise<string> {
    await mkdir(this.deps.runtimeHomeRoot, { recursive: true, mode: 0o700 })
    const root = await lstat(this.deps.runtimeHomeRoot)
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('delegated runtime home root must be a real directory')
    }
    const uid = process.getuid?.()
    if (uid !== undefined && root.uid !== uid) {
      throw new Error('delegated runtime home root must be owned by the daemon user')
    }
    await chmod(this.deps.runtimeHomeRoot, 0o700)
    const runtimeHome = await mkdtemp(join(this.deps.runtimeHomeRoot, 'cell-'))
    await chmod(runtimeHome, 0o700)
    return runtimeHome
  }

  private assertCanStart(): void {
    if (this.stopped) throw new Error('delegated webchat host manager is stopped')
    if (!this.deps.isolationHealthy()) {
      throw new Error('delegated webchat isolation is unavailable')
    }
  }

  private assertPendingCanStart(pending: PendingStart): void {
    this.assertCanStart()
    if (pending.cancelled) throw new Error('delegated webchat host start was cancelled')
  }

  private async raceCancellation<T>(operation: Promise<T>, pending: PendingStart): Promise<T> {
    return Promise.race([
      operation,
      pending.cancelSignal.then(() => {
        throw new Error('delegated webchat host start was cancelled')
      })
    ])
  }

  private async onBridgeDisconnect(event: SessionMcpBridgeDisconnected): Promise<void> {
    const key = logicalKey(event)
    const record = this.active.get(key) ?? this.draining.get(key)
    if (!record || !sameFence(record, event)) return
    try {
      await this.teardown(record, 'bridge_disconnect')
    } catch {
      // teardown already emitted identifier-free classified errors and retained
      // the record for retry.
    }
  }

  private async stopMatching(
    matches: (record: Pick<CellRecord, 'agentId' | 'conversationId'>) => boolean,
    source: CleanupSource
  ): Promise<StartDelegatedWebchatHost[]> {
    const pending = [...this.pending.values()].filter((start) => matches(start.authority))
    const records = new Set<CellRecord>([
      ...[...this.active.values()].filter(matches),
      ...[...this.draining.values()].filter(matches),
      ...pending.flatMap((start) => (start.record ? [start.record] : []))
    ])
    for (const start of pending) start.cancel()
    await Promise.all(pending.map((start) => start.promise.catch(() => undefined)))

    for (const record of this.active.values()) if (matches(record)) records.add(record)
    for (const record of this.draining.values()) if (matches(record)) records.add(record)
    for (const start of pending) if (start.record) records.add(start.record)
    await Promise.all([...records].map((record) => this.teardown(record, source)))
    return [...records].map((record) => this.authority(record))
  }

  private retainInactiveAuthorities(authorities: StartDelegatedWebchatHost[]): void {
    this.pruneInactiveAuthorities()
    for (const authority of authorities) {
      this.inactiveAuthorities.set(logicalKey(authority), authority)
    }
  }

  private pruneInactiveAuthorities(now = Date.now()): void {
    for (const [key, authority] of this.inactiveAuthorities) {
      const expiresAt = Date.parse(authority.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt <= now) this.inactiveAuthorities.delete(key)
    }
  }

  private teardown(record: CellRecord, source: CleanupSource): Promise<void> {
    if (record.teardown) return record.teardown
    const active = this.active.get(record.key)
    const draining = this.draining.get(record.key)
    const pending = this.pending.get(record.key)?.record
    if (active !== record && draining !== record && pending !== record) {
      return Promise.resolve()
    }
    if (draining && draining !== record) {
      return Promise.resolve()
    }
    if (active === record) this.active.delete(record.key)
    this.draining.set(record.key, record)
    record.teardown = this.runTeardown(record, source)
      .then(() => {
        if (source !== 'manager_stop') this.retainInactiveAuthorities([this.authority(record)])
      })
      .finally(() => {
        record.teardown = undefined
        if (this.teardownComplete(record) && this.draining.get(record.key) === record) {
          this.draining.delete(record.key)
        }
      })
    return record.teardown
  }

  private async runTeardown(record: CellRecord, source: CleanupSource): Promise<void> {
    // Cancellation races only the caller-visible startup. A broker registration is
    // an authority-bearing raw operation and may still succeed afterward; cleanup
    // cannot report completion until that result is known and any late cell is
    // drained/released below.
    await record.registration?.catch(() => undefined)
    const failures: Error[] = []
    const step = async (name: CleanupStep, done: () => boolean, run: () => Promise<void>) => {
      if (done()) return
      try {
        await run()
      } catch {
        failures.push(new Error(`delegated cleanup step failed: ${name}`))
        this.reportCleanupError({ source, step: name, retryable: true })
      }
    }
    const fence: ReleaseSessionMcpCell = {
      isolationCellId: record.isolationCellId,
      agentId: record.agentId,
      conversationId: record.conversationId,
      delegationId: record.delegationId,
      generation: record.generation
    }

    if (record.registered) {
      await step(
        'broker_drain',
        () => record.drained,
        async () => {
          if (!(await this.deps.broker.beginDrainCell(fence))) throw new Error('broker drain fence mismatch')
          record.drained = true
        }
      )
    } else if (record.registrationSettled) {
      record.drained = true
      record.released = true
    }
    if (record.registered && !record.drained) {
      throw new AggregateError(failures, 'delegated webchat cleanup incomplete')
    }

    if (record.host) {
      await step(
        'host_stop',
        () => record.hostStopped,
        async () => {
          await record.host!.stop()
          record.hostStopped = true
        }
      )
    } else if (record.hostCreationSettled) {
      record.hostStopped = true
    }

    if (record.registered && record.drained) {
      await step(
        'broker_release',
        () => record.released,
        async () => {
          if (!(await this.deps.broker.releaseCell(fence))) throw new Error('broker release fence mismatch')
          record.released = true
        }
      )
    }

    await step(
      'home_remove',
      () => record.homeRemoved,
      async () => {
        await (this.deps.removeRuntimeHome ?? this.defaultRemoveRuntimeHome)(record.runtimeHome)
        record.homeRemoved = true
      }
    )

    if (failures.length) throw new AggregateError(failures, 'delegated webchat cleanup incomplete')
  }

  private readonly defaultRemoveRuntimeHome = (path: string) => rm(path, { recursive: true, force: true })

  private teardownComplete(record: CellRecord): boolean {
    return (
      record.allocationSettled &&
      record.registrationSettled &&
      record.hostCreationSettled &&
      record.drained &&
      record.hostStopped &&
      record.released &&
      record.homeRemoved
    )
  }

  private reportCleanupError(event: DelegatedHostCleanupError): void {
    try {
      this.deps.log?.warn(`delegated webchat cleanup failed at ${event.step}; retry retained`)
    } catch {
      // Logging is never part of cleanup correctness.
    }
    try {
      this.deps.onCleanupError?.({ ...event })
    } catch {
      // Observability callbacks are containment boundaries.
    }
  }

  private publicHost(record: CellRecord): DelegatedWebchatHost {
    if (!record.host || !record.adminMcpServer || !record.mount) {
      throw new Error('delegated webchat host is not fully initialized')
    }
    return {
      isolationCellId: record.isolationCellId,
      host: record.host,
      runtimeHome: record.runtimeHome,
      adminMcpServer: record.adminMcpServer,
      mount: record.mount
    }
  }

  private authority(record: CellRecord): StartDelegatedWebchatHost {
    return {
      agentId: record.agentId,
      conversationId: record.conversationId,
      delegationId: record.delegationId,
      generation: record.generation,
      expiresAt: record.expiresAt
    }
  }
}
