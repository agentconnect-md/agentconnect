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

type BrokerPort = Pick<SessionMcpBroker, 'registerCell' | 'getCellMount' | 'releaseCell' | 'subscribeBridgeDisconnect'>

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

interface CellRecord extends DelegatedWebchatHost, ReleaseSessionMcpCell {
  key: string
  expiresAt: string
  teardown?: Promise<void>
}

interface PendingStart {
  authority: StartDelegatedWebchatHost
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
  private readonly pending = new Map<string, PendingStart>()
  private readonly unsubscribeBridgeDisconnect: () => void
  private stopped = false

  constructor(private readonly deps: DelegatedWebchatHostManagerDeps) {
    if (!deps.isolationHealthy()) {
      throw new Error('delegated webchat isolation is unavailable')
    }
    // Subscribe before any host can start and open its cell-local bridge.
    this.unsubscribeBridgeDisconnect = deps.broker.subscribeBridgeDisconnect((event) => {
      void this.onBridgeDisconnect(event)
    })
  }

  async startHost(input: StartDelegatedWebchatHost): Promise<DelegatedWebchatHost> {
    this.assertCanStart()
    const key = logicalKey(input)
    const pending = this.pending.get(key)
    if (pending) {
      if (!sameAuthority(pending.authority, input)) {
        throw new Error(`conversation ${input.conversationId} is already starting with different authority`)
      }
      return pending.promise
    }
    const active = this.active.get(key)
    if (active) {
      if (!sameAuthority(active, input)) {
        throw new Error(`conversation ${input.conversationId} already has an active isolated host`)
      }
      return this.publicHost(active)
    }

    const promise = this.allocateAndStart(input, key)
    this.pending.set(key, { authority: input, promise })
    try {
      return await promise
    } finally {
      const current = this.pending.get(key)
      if (current?.promise === promise) this.pending.delete(key)
    }
  }

  async stopHost(input: { agentId: string; conversationId: string; isolationCellId: string }): Promise<boolean> {
    const record = this.active.get(logicalKey(input))
    if (!record || record.isolationCellId !== input.isolationCellId) return false
    await this.teardown(record)
    return true
  }

  /** Manager shutdown is local cell teardown only. The owning daemon calls
   * SessionMcpBroker.stop() exactly once at its own terminal boundary. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unsubscribeBridgeDisconnect()
    await Promise.allSettled([...this.pending.values()].map(({ promise }) => promise))
    await Promise.all([...this.active.values()].map((record) => this.teardown(record)))
  }

  debugStats(): { activeHosts: number; pendingStarts: number; stopped: boolean } {
    return { activeHosts: this.active.size, pendingStarts: this.pending.size, stopped: this.stopped }
  }

  private async allocateAndStart(input: StartDelegatedWebchatHost, key: string): Promise<DelegatedWebchatHost> {
    const isolationCellId = this.deps.randomCellId?.() ?? randomUUID()
    const runtimeHome = await this.createRuntimeHome()
    let record: CellRecord | undefined
    let registeredFence: ReleaseSessionMcpCell | undefined
    try {
      const registration: RegisterSessionMcpCell = {
        isolationCellId,
        platform: 'webchat',
        ...input
      }
      const adminMcpServer = await this.deps.broker.registerCell(registration)
      if (!adminMcpServer) throw new Error('delegated webchat broker refused the isolation cell')
      registeredFence = {
        isolationCellId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        delegationId: input.delegationId,
        generation: input.generation
      }
      this.assertCanStart()
      const mount = this.deps.broker.getCellMount(isolationCellId)
      if (!mount || !strictlyInside(this.deps.brokerSourceRoot, mount.sourceDirectory)) {
        throw new Error('delegated webchat broker returned an invalid cell mount')
      }

      const onTerminal = () => {
        if (record) void this.teardown(record).catch(() => undefined)
      }
      const host = this.deps.hostFactory({
        agentId: input.agentId,
        conversationId: input.conversationId,
        runtimeHome,
        adminMcpServer,
        sandbox: {
          mechanism: 'bwrap',
          writable: [runtimeHome],
          maskedReadRoots: [this.deps.brokerSourceRoot],
          delegatedCellMount: {
            maskedRoot: this.deps.brokerSourceRoot,
            sourceDir: mount.sourceDirectory,
            targetDir: mount.targetDirectory
          }
        },
        onTerminal
      })
      record = {
        key,
        ...registeredFence,
        expiresAt: input.expiresAt,
        host,
        runtimeHome,
        adminMcpServer,
        mount
      }
      this.active.set(key, record)
      await host.start()
      if (this.stopped || !this.deps.isolationHealthy() || this.active.get(key) !== record || record.teardown) {
        throw new Error('delegated webchat host terminated during startup')
      }
      return this.publicHost(record)
    } catch (error) {
      if (record) {
        await this.teardown(record).catch(() => undefined)
      } else {
        if (registeredFence) {
          await this.deps.broker.releaseCell(registeredFence).catch(() => undefined)
        }
        await rm(runtimeHome, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  private async createRuntimeHome(): Promise<string> {
    await mkdir(this.deps.runtimeHomeRoot, { recursive: true, mode: 0o700 })
    const root = await lstat(this.deps.runtimeHomeRoot)
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('delegated runtime home root must be a real directory')
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

  private async onBridgeDisconnect(event: SessionMcpBridgeDisconnected): Promise<void> {
    const record = this.active.get(logicalKey(event))
    if (!record || !sameFence(record, event)) return
    await this.teardown(record)
  }

  private teardown(record: CellRecord): Promise<void> {
    if (record.teardown) return record.teardown
    record.teardown = (async () => {
      if (this.active.get(record.key) === record) this.active.delete(record.key)
      let firstError: unknown
      try {
        await record.host.stop()
      } catch (error) {
        firstError = error
      }
      try {
        await this.deps.broker.releaseCell({
          isolationCellId: record.isolationCellId,
          agentId: record.agentId,
          conversationId: record.conversationId,
          delegationId: record.delegationId,
          generation: record.generation
        })
      } catch (error) {
        firstError ??= error
      }
      try {
        await rm(record.runtimeHome, { recursive: true, force: true })
      } catch (error) {
        firstError ??= error
      }
      if (firstError) throw firstError
    })()
    return record.teardown
  }

  private publicHost(record: CellRecord): DelegatedWebchatHost {
    return {
      isolationCellId: record.isolationCellId,
      host: record.host,
      runtimeHome: record.runtimeHome,
      adminMcpServer: record.adminMcpServer,
      mount: record.mount
    }
  }
}
