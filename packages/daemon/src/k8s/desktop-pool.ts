// Desktop claims for managed computers (computer-use.md §15.1): this member creates, suspends, resumes and deletes them for the CP.
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type {
  ComputerAllocation,
  ComputerPoolClaimState,
  ComputerPoolOp,
  ComputerPoolOpResult,
  ComputerPoolRegistration
} from '@agentconnect.md/protocol'
import {
  isSandboxReady,
  OperatingModeRejectedError,
  type Sandbox,
  type SandboxApi,
  type SandboxClaim
} from './sandbox-api.js'
import { resolvePodIp } from './sandbox-identity.js'

/** A desktop claim's own labels; never `agentconnect.md/agent`, so the agent orphan sweep leaves desktops alone. */
export const AC_LABEL_COMPUTER = 'agentconnect.md/computer'
export const AC_LABEL_COMPUTER_ALLOCATION = 'agentconnect.md/computer-allocation'

/** The warm pool desktop claims reference; setting it is what makes a member serve desktop claims. */
export const K8S_DESKTOP_WARM_POOL_ENV = 'AC_K8S_DESKTOP_WARM_POOL'
/** The port a desktop pod's pool bootstrap listens on. */
export const K8S_DESKTOP_BOOTSTRAP_PORT_ENV = 'AC_K8S_DESKTOP_BOOTSTRAP_PORT'
export const DEFAULT_DESKTOP_BOOTSTRAP_PORT = 7690

export interface DesktopPoolSettings {
  warmPoolName: string
  bootstrapPort: number
}

/** The deployment's desktop pool, or undefined when this member serves no desktop claims. */
export function desktopPoolSettings(env: NodeJS.ProcessEnv): DesktopPoolSettings | undefined {
  const warmPoolName = env[K8S_DESKTOP_WARM_POOL_ENV]?.trim()
  if (!warmPoolName) return undefined
  const raw = env[K8S_DESKTOP_BOOTSTRAP_PORT_ENV]?.trim() || String(DEFAULT_DESKTOP_BOOTSTRAP_PORT)
  const bootstrapPort = Number(raw)
  if (!Number.isInteger(bootstrapPort) || bootstrapPort < 1 || bootstrapPort > 65_535) {
    throw new Error(`${K8S_DESKTOP_BOOTSTRAP_PORT_ENV} is not a valid port: ${raw}`)
  }
  return { warmPoolName, bootstrapPort }
}

export const desktopClaimName = (computerId: string): string => `desktop-${computerId}`

/** What a desktop pod's bootstrap answers: whether it holds a key, and for which Computer. */
export interface DesktopBootstrapStatus {
  registered: boolean
  computerId?: string
}

/** The pod side of registration: the member dials the pod, as it dials an agent pod's shim (k8s-daemon-pool.md D3). */
export interface DesktopBootstrap {
  status(address: string, port: number): Promise<DesktopBootstrapStatus>
  register(address: string, port: number, registration: ComputerPoolRegistration): Promise<DesktopBootstrapStatus>
}

const hostOf = (ip: string): string => (ip.includes(':') ? `[${ip}]` : ip)

async function readStatus(res: Response): Promise<DesktopBootstrapStatus> {
  const body = (await res.json()) as { registered?: unknown; computerId?: unknown }
  return {
    registered: body.registered === true,
    ...(typeof body.computerId === 'string' ? { computerId: body.computerId } : {})
  }
}

/** The bootstrap over plain HTTP inside the cluster; the NetworkPolicy admits only pool members to the port. */
export const httpDesktopBootstrap: DesktopBootstrap = {
  async status(address, port) {
    const res = await fetch(`http://${hostOf(address)}:${port}/pool/status`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new Error(`desktop bootstrap status answered ${res.status}`)
    return await readStatus(res)
  },
  async register(address, port, registration) {
    const res = await fetch(`http://${hostOf(address)}:${port}/pool/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration),
      signal: AbortSignal.timeout(45_000)
    })
    // 409: it registered already, maybe from an earlier push whose answer was lost.
    if (res.ok || res.status === 409) return await readStatus(res)
    throw new Error(`desktop registration answered ${res.status}`)
  }
}

export interface DesktopPoolDeps {
  api: Pick<
    SandboxApi,
    'ensureClaim' | 'getClaim' | 'getSandbox' | 'deleteClaim' | 'listClaims' | 'setOperatingModeIfCurrent'
  >
  settings: DesktopPoolSettings
  bootstrap?: DesktopBootstrap
  log?: { info(message: string): void; warn(message: string): void }
}

const failure = (error: unknown): ComputerPoolOpResult => ({
  ok: false,
  error: (error instanceof Error ? error.message : String(error)).slice(0, 500)
})

const isNotFound = (err: unknown): boolean => err instanceof K8sApiError && err.isNotFound

/** Why a Sandbox is not ready yet, from its Ready condition. */
function readinessDetail(sandbox: Sandbox): string | undefined {
  const ready = (sandbox.status?.conditions ?? []).find((condition) => condition.type === 'Ready') as
    { message?: string; reason?: string } | undefined
  const detail = ready?.message ?? ready?.reason
  return detail ? detail.slice(0, 500) : undefined
}

export class DesktopPool {
  private readonly bootstrap: DesktopBootstrap
  private readonly inflight = new Map<string, { key: string; work: Promise<ComputerPoolOpResult> }>()

  constructor(private readonly deps: DesktopPoolDeps) {
    this.bootstrap = deps.bootstrap ?? httpDesktopBootstrap
  }

  /** Serve one `computer-pool/op`; ops on one desktop run one at a time, a resent one joins it, a different one runs after it. */
  async handle(op: ComputerPoolOp): Promise<ComputerPoolOpResult> {
    if (op.op === 'list') return await this.list().catch(failure)
    const id = op.computerId
    const key = JSON.stringify(op)
    const prior = this.inflight.get(id)
    if (prior?.key === key) return await prior.work
    const work: Promise<ComputerPoolOpResult> = (async () => {
      await prior?.work
      return op.op === 'ensure' ? await this.ensure(op) : await this.remove(id)
    })()
      .catch(failure)
      .finally(() => {
        if (this.inflight.get(id)?.work === work) this.inflight.delete(id)
      })
    this.inflight.set(id, { key, work })
    return await work
  }

  private async ensure(op: Extract<ComputerPoolOp, { op: 'ensure' }>): Promise<ComputerPoolOpResult> {
    const state = (patch: Partial<ComputerPoolClaimState>): ComputerPoolOpResult => ({
      ok: true,
      state: { computerId: op.computerId, claim: 'present', ...patch }
    })
    const name = desktopClaimName(op.computerId)
    let claim: SandboxClaim
    if (op.create) {
      claim = (await this.deps.api.ensureClaim(this.claimFor(op.computerId, op.allocation))).claim
    } else {
      try {
        claim = await this.deps.api.getClaim(name)
      } catch (err) {
        // A wake never creates: a claim that is gone took the volume with it.
        if (isNotFound(err)) return state({ claim: 'missing', pod: 'none' })
        throw err
      }
    }
    const created = claim.metadata?.creationTimestamp
      ? { createdAt: new Date(claim.metadata.creationTimestamp).toISOString() }
      : {}
    const sandboxName = claim.status?.sandbox?.name
    if (!sandboxName) return state({ pod: op.running ? 'starting' : 'none', ...created })
    let sandbox: Sandbox
    try {
      sandbox = await this.deps.api.getSandbox(sandboxName)
    } catch (err) {
      if (isNotFound(err)) return state({ pod: op.running ? 'starting' : 'none', ...created })
      throw err
    }
    const uid = sandbox.metadata?.uid
    const mode = sandbox.spec?.operatingMode ?? 'Running'
    if (!op.running) {
      if (mode === 'Running' && uid) await this.switchMode(sandboxName, 'Suspended', 'Running', uid)
      return state({ pod: 'suspended', ...created })
    }
    if (mode === 'Suspended') {
      if (uid) await this.switchMode(sandboxName, 'Running', 'Suspended', uid)
      this.deps.log?.info(`desktop pool: resuming ${sandboxName} for computer ${op.computerId}`)
      return state({ pod: 'starting', ...created })
    }
    const podIp = resolvePodIp(sandbox)
    if (!isSandboxReady(sandbox) || !podIp) {
      const detail = readinessDetail(sandbox)
      return state({ pod: 'starting', ...created, ...(detail ? { detail } : {}) })
    }
    let status: DesktopBootstrapStatus
    try {
      status = await this.bootstrap.status(podIp, this.deps.settings.bootstrapPort)
    } catch (err) {
      // The pod is up but its daemon is not answering yet.
      return state({
        pod: 'starting',
        ...created,
        detail: `desktop daemon not answering: ${(err as Error).message}`.slice(0, 500)
      })
    }
    if (!status.registered && op.registration) {
      status = await this.bootstrap.register(podIp, this.deps.settings.bootstrapPort, op.registration)
      this.deps.log?.info(`desktop pool: registered ${sandboxName} as computer ${status.computerId ?? op.computerId}`)
    }
    return state({
      pod: 'running',
      registered: status.registered,
      ...(status.computerId ? { registeredComputerId: status.computerId } : {}),
      ...created
    })
  }

  // A raced mode write is the next op's to observe; it is never forced through.
  private async switchMode(
    name: string,
    mode: 'Running' | 'Suspended',
    observed: 'Running' | 'Suspended',
    uid: string
  ) {
    try {
      await this.deps.api.setOperatingModeIfCurrent(name, mode, observed, uid)
    } catch (err) {
      if (!(err instanceof OperatingModeRejectedError)) throw err
    }
  }

  private async remove(computerId: string): Promise<ComputerPoolOpResult> {
    await this.deps.api.deleteClaim(desktopClaimName(computerId))
    this.deps.log?.info(`desktop pool: deleted the claim and volume of computer ${computerId}`)
    return { ok: true, state: { computerId, claim: 'deleted', pod: 'none' } }
  }

  private async list(): Promise<ComputerPoolOpResult> {
    const claims = await this.deps.api.listClaims(AC_LABEL_COMPUTER)
    const states: ComputerPoolClaimState[] = []
    for (const claim of claims) {
      const computerId = claim.metadata?.labels?.[AC_LABEL_COMPUTER]
      if (!computerId || !/^[0-9a-f-]{36}$/i.test(computerId)) continue
      const createdAt = claim.metadata?.creationTimestamp
      states.push({
        computerId,
        claim: 'present',
        ...(createdAt ? { createdAt: new Date(createdAt).toISOString() } : {})
      })
    }
    return { ok: true, claims: states }
  }

  private claimFor(computerId: string, allocation: ComputerAllocation): SandboxClaim & { metadata: { name: string } } {
    const labels = { [AC_LABEL_COMPUTER]: computerId, [AC_LABEL_COMPUTER_ALLOCATION]: allocation }
    return {
      metadata: { name: desktopClaimName(computerId), labels },
      spec: { warmPoolRef: { name: this.deps.settings.warmPoolName }, additionalPodMetadata: { labels } }
    }
  }
}
