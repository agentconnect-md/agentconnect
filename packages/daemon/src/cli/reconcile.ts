/**
 * `agentconnect-daemon reconcile --once` — one orphan sweep, then exit.
 *
 * The reconciler is a Kubernetes CronJob, not a timer inside every pool member: the cluster owns
 * the schedule, `concurrencyPolicy: Forbid` is the mutual exclusion a lease used to provide, and a
 * failed run is a failed Job the cluster already reports. So this boots the minimum a sweep needs —
 * the sandbox API surface, the shared data-plane store, and a control-plane connection to ask which
 * agents still exist — and nothing else: no agents, no platform connections (k8s-daemon-pool.md §4).
 *
 * Both halves run in the one job because they ask the control plane the SAME question: the batched
 * `agent/exists` read answers "is this leaked?" for a `SandboxClaim` and for an outbox row alike.
 * The store half is skipped where no shared data plane is mounted — a local single-daemon store has
 * one owner forever and its rows are its own to drain. The store is also what answers for a SESSION
 * pod (git-workspace-model.md §11): its claim lives as long as its session row, so a pod whose row is
 * gone is an orphan — and without a store every session pod reads as live.
 *
 * The connection registers as an OBSERVER. It presents the same projected pool identity a member
 * does, so the control plane admits it on the same TokenReview path, but it is enrolled in no
 * member set and is granted no duty — a job that sweeps must never be handed work to serve.
 */
import { existsSync } from 'node:fs'
import type { AnyFrame, AgentExistsOk, FrameType } from '@agentconnect.md/protocol'
import {
  AGENT_EXISTS_MAX,
  buildEnvelope,
  CP_SUBPROTOCOL,
  CP_URL_ENV,
  CP_WS_PATH,
  decodeCpEnvelope
} from '@agentconnect.md/protocol'
import { ClientTransport, ReqRep, systemClock, type Transport } from '@agentconnect.md/connection'
import { K8sHttp, loadInClusterConfig } from '@agentconnect.md/k8s-client'
import { SandboxApi } from '../k8s/sandbox-api.js'
import { OrphanReconciler, resolveOrphanReconcilerSettings } from '../k8s/orphan-reconciler.js'
import { K8S_SANDBOX_NAMESPACE_ENV } from '../k8s/runtime-plane.js'
import { readClusterIdentityToken } from '../cp/cluster-identity.js'
import { DATA_PLANE_CONFIG_PATH } from '../store/postgres-config.js'
import { openMountedPostgresDataPlane } from '../store/postgres-data-plane.js'
import { StoreRetentionSweeper, resolveStoreRetentionSettings } from '../store/retention.js'
import type { RetentionCapableStore } from '../store/retention.js'
import type { LocalStore } from '../store/local-store.js'
import { hostKeyDirName, sessionHostKey } from '../acp/host-key.js'
import { sessionSandboxSubject } from '../k8s/sandbox-identity.js'
import { DAEMON_VERSION } from '../version.js'

const REQUEST_TIMEOUT_MS = 15_000

/** What the sweep needs from the control plane, and nothing more. */
export interface ExistenceReader {
  liveAgents: (agentIds: string[]) => Promise<Set<string>>
  close: () => void
}

/** The shared data-plane store, plus how to give it back; one that lists session keys also answers for session pods. */
export interface ReapableStore {
  store: RetentionCapableStore & Partial<Pick<LocalStore, 'sessionKeysForAgent'>>
  close: () => Promise<void>
}

export interface ReconcileOnceOpts {
  env?: NodeJS.ProcessEnv
  /** Control-plane WS URL; defaults to the pod's `AC_CP_URL`. */
  apiUrl?: string
  log?: { info: (m: string) => void; warn: (m: string) => void }
  /** Seams the tests replace: the cluster surface, the store, and the control-plane read. */
  api?: SandboxApi
  connectCp?: (url: string) => Promise<ExistenceReader>
  /** Resolves undefined when this deployment mounts no shared data plane. */
  openStore?: () => Promise<ReapableStore | undefined>
}

/** The socket and the credential, injected so the handshake is testable without a cluster. */
export interface ObserverSeams {
  dial?: (url: string) => Promise<Transport>
  token?: () => string | undefined
}

const dialCp = (url: string): Promise<Transport> =>
  ClientTransport.dial(url, { subprotocol: CP_SUBPROTOCOL, path: CP_WS_PATH, handshakeTimeoutMs: REQUEST_TIMEOUT_MS })

/** Exit code: 0 only when both sweeps ran AND collected everything they decided to; 1 otherwise. */
export async function runReconcileOnce(opts: ReconcileOnceOpts = {}): Promise<number> {
  const env = opts.env ?? process.env
  const log = opts.log ?? { info: (m: string) => console.log(m), warn: (m: string) => console.error(m) }
  let cp: ExistenceReader | undefined
  let mounted: ReapableStore | undefined
  try {
    const settings = resolveOrphanReconcilerSettings(env)
    const storeSettings = resolveStoreRetentionSettings(env)
    // The namespace is resolved BEFORE the in-cluster config: a missing env var must name itself,
    // not surface as "this process is not in a pod".
    const namespace = opts.api ? undefined : sandboxNamespace(env)
    const api = opts.api ?? new SandboxApi(new K8sHttp(loadInClusterConfig()), namespace!)
    const url = opts.apiUrl ?? env[CP_URL_ENV]?.trim()
    if (!url) throw new Error(`reconcile requires the control plane's address in ${CP_URL_ENV}`)
    cp = await (opts.connectCp ?? connectObserver)(url)
    const liveAgents = cp.liveAgents
    // The store first: it is what answers for a session pod's row (git-workspace-model.md §11).
    mounted = await (opts.openStore ?? openSharedStore)()
    const sessionKeys = mounted?.store.sessionKeysForAgent?.bind(mounted.store)
    const liveSessionLeaves = sessionKeys ? liveSessionLeavesFrom(sessionKeys) : undefined
    const reconciler = new OrphanReconciler({
      api,
      liveAgents,
      ...(liveSessionLeaves ? { liveSessionLeaves } : {}),
      settings,
      log
    })
    const summary = await reconciler.sweep()
    // No data plane is not a failure: this deployment keeps no shared store to sweep.
    // No `ownerId`: a one-shot job owns no rows, so every rule keeps its conservative window.
    const storeSummary = mounted
      ? await new StoreRetentionSweeper({ store: mounted.store, liveAgents, settings: storeSettings, log }).sweep()
      : { failed: 0 }
    // A delete that failed is counted, not thrown, so the run reports the whole picture — but a run
    // that left an orphan behind is not a successful Job, or the cluster hides a leak that repeats.
    return summary?.failed === 0 && storeSummary?.failed === 0 ? 0 : 1
  } catch (err) {
    log.warn(`reconcile: sweep failed — ${(err as Error).message}`)
    return 1
  } finally {
    cp?.close()
    await mounted?.close().catch(() => undefined)
  }
}

/** Which session pods still have a row: one store read per agent, the leaves derived as the host keys derive them. */
function liveSessionLeavesFrom(
  sessionKeysForAgent: LocalStore['sessionKeysForAgent']
): NonNullable<ConstructorParameters<typeof OrphanReconciler>[0]['liveSessionLeaves']> {
  return async (sessions) => {
    const live = new Set<string>()
    for (const agentId of new Set(sessions.map((session) => session.agentId))) {
      for (const key of await sessionKeysForAgent(agentId)) {
        live.add(sessionSandboxSubject(agentId, hostKeyDirName(sessionHostKey(agentId, key))))
      }
    }
    return live
  }
}

/** The pool's shared store, or undefined where the deployment mounts none. */
async function openSharedStore(): Promise<ReapableStore | undefined> {
  if (!existsSync(DATA_PLANE_CONFIG_PATH)) return undefined
  // The reaper reads and deletes outbox rows only; no transcript write needs an org resolver.
  const plane = await openMountedPostgresDataPlane(() => undefined)
  return { store: plane.store, close: () => plane.close() }
}

function sandboxNamespace(env: NodeJS.ProcessEnv): string {
  const namespace = env[K8S_SANDBOX_NAMESPACE_ENV]?.trim()
  if (!namespace) throw new Error(`reconcile requires ${K8S_SANDBOX_NAMESPACE_ENV}`)
  return namespace
}

/**
 * Dial the control plane, hand it this pod's projected identity, and register as an observer.
 *
 * Deliberately not `CpClient`: that client is a member's whole control surface — heartbeats, duty
 * leases, snapshot convergence, reconnect — and a one-shot job that asks a single question needs
 * none of it. Sending no heartbeat is also what keeps the observer's row collectable: the control
 * plane backdates it at register, and nothing here moves it forward again.
 */
export async function connectObserver(url: string, seams: ObserverSeams = {}): Promise<ExistenceReader> {
  const token = (seams.token ?? readClusterIdentityToken)()
  if (!token) throw new Error("reconcile requires this pod's projected control-plane identity token")
  const correlator = new ReqRep<AnyFrame>(systemClock, REQUEST_TIMEOUT_MS, 1)
  const transport: Transport = await (seams.dial ?? dialCp)(url)
  const request = async (type: FrameType, payload: unknown): Promise<AnyFrame> =>
    correlator.request(buildEnvelope(type, payload), (encoded) => transport.send(encoded), {
      maxTries: 1,
      ackTimeoutMs: REQUEST_TIMEOUT_MS
    })
  try {
    transport.onMessage((text) => {
      const decoded = decodeCpEnvelope(text)
      if (decoded.ok && decoded.frame.corr) correlator.settle(decoded.frame)
    })
    transport.onClose(() => correlator.rejectAll(new Error('control-plane connection closed')))
    const auth = await request('auth', { serviceAccountToken: token, agentVersion: DAEMON_VERSION })
    if (auth.type !== 'auth/ok') throw new Error(`expected auth/ok, got ${auth.type}`)
    const registered = await request('register', {
      host: 'reconcile',
      observer: true,
      capabilities: { platforms: [], runtimes: [], acp: false, features: [] },
      maxAgents: 0,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    })
    if (registered.type !== 'register/ok') throw new Error(`expected register/ok, got ${registered.type}`)
  } catch (err) {
    correlator.rejectAll(new Error('observer registration failed'))
    transport.close(1011, 'observer registration failed')
    throw err
  }
  return {
    // Chunked at the frame's own cap; an error reply throws, which fails the sweep rather than
    // letting an unanswerable question read as "these agents are gone".
    liveAgents: async (agentIds) => {
      const live = new Set<string>()
      for (let at = 0; at < agentIds.length; at += AGENT_EXISTS_MAX) {
        const reply = await request('agent/exists', { agentIds: agentIds.slice(at, at + AGENT_EXISTS_MAX) })
        if (reply.type !== 'agent/exists/ok') throw new Error(`expected agent/exists/ok, got ${reply.type}`)
        for (const id of (reply.payload as AgentExistsOk).existing) live.add(id)
      }
      return live
    },
    close: () => {
      correlator.rejectAll(new Error('reconcile complete'))
      transport.close(1000, 'reconcile complete')
    }
  }
}
