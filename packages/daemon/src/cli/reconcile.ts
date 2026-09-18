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
 *
 * It asks that one question about PLACEMENT, not existence alone, because the two differ in the one
 * case neither sweep could otherwise reach: an agent MOVED off this pool. Its objects and rows stay
 * behind, and every guard reads them as live — no member holds its duty, so none sweeps its sessions
 * or suspends its pods, while `agent/exists` says the agent is perfectly alive. Nothing here would
 * ever collect them. So a moved agent gets its own, deliberately long window
 * ({@link MOVED_GRACE_ENV}): the move is meant to be reversible and the volume left behind is that
 * promise, but a promise with no end is a pod and a PVC per move, forever. Past the window the
 * sessions are purged like any expired ones, and the claims — the pods and their volumes with
 * them — are collected.
 */
import { existsSync } from 'node:fs'
import type { AnyFrame, AgentExistsOk, AuthOk, FrameType, RegisterOk } from '@agentconnect.md/protocol'
import {
  AGENT_EXISTS_MAX,
  AGENT_PLACEMENT_FEATURE,
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

/** How the control plane reads for these agents: gone, live here, or live but placed elsewhere —
 *  and for that last one, the epoch ms its placement changed, which is the only clock a scheduled
 *  sweep can trust for a departure. */
export type AgentStanding = { at: 'gone' } | { at: 'here' } | { at: 'elsewhere'; since: number }

/** What the sweep needs from the control plane, and nothing more. */
export interface ExistenceReader {
  /** One batched read per chunk. An id missing from the answer is `gone`; `elsewhere` is only ever
   *  reported when the control plane answered the placement question, so a CP that cannot is
   *  indistinguishable from a pool that still holds everything — which collects less, never more. */
  readAgents: (agentIds: string[]) => Promise<Map<string, AgentStanding>>
  close: () => void
}

/** The shared data-plane store, plus how to give it back; one that lists session keys also answers for session pods. */
export interface ReapableStore {
  store: RetentionCapableStore &
    Partial<Pick<LocalStore, 'sessionKeysForAgent' | 'listExpiredSessions' | 'deleteSession'>>
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
    // Existence is cached for the run; placement never is — an agent that left can come back, and a
    // destructive pass must not act on a snapshot that predates its return.
    const standing = standingCache(cp.readAgents)
    const liveAgents = standing.live
    const movedAgents = standing.moved
    // The store first: it is what answers for a session pod's row (git-workspace-model.md §11).
    mounted = await (opts.openStore ?? openSharedStore)()
    const sessionKeys = mounted?.store.sessionKeysForAgent?.bind(mounted.store)
    const liveSessionLeaves = sessionKeys ? liveSessionLeavesFrom(sessionKeys) : undefined
    const reconciler = new OrphanReconciler({
      api,
      liveAgents,
      movedAgents,
      ...(liveSessionLeaves ? { liveSessionLeaves } : {}),
      settings,
      log
    })
    const summary = await reconciler.sweep()
    // No data plane is not a failure: this deployment keeps no shared store to sweep.
    // No `ownerId`: a one-shot job owns no rows, so every rule keeps its conservative window.
    const storeSummary = mounted
      ? await new StoreRetentionSweeper({
          store: mounted.store,
          liveAgents,
          // The store's proof is ownership, not age: a row of an agent no member here holds will
          // never be drained by one, whether it left a minute or a month ago.
          movedAgents: async (ids) => new Set((await movedAgents(ids)).keys()),
          settings: storeSettings,
          log
        }).sweep()
      : { failed: 0 }
    // The rows the sweep above cannot reach: a departed agent's pods are claims, and the orphan sweep
    // took those, but its SESSIONS are rows in a store no member of this pool judges any more. Same
    // window as the moved claims, and the same dry run, so one decision covers the pod and its row.
    const purged = mounted
      ? await purgeMovedAgentSessions({
          store: mounted.store,
          movedAgents,
          movedGraceMs: settings.movedGraceMs,
          deleteEnabled: storeSettings.deleteOrphans,
          log
        })
      : { failed: 0 }
    // A delete that failed is counted, not thrown, so the run reports the whole picture — but a run
    // that left an orphan behind is not a successful Job, or the cluster hides a leak that repeats.
    return summary?.failed === 0 && storeSummary?.failed === 0 && purged.failed === 0 ? 0 : 1
  } catch (err) {
    log.warn(`reconcile: sweep failed — ${(err as Error).message}`)
    return 1
  } finally {
    cp?.close()
    await mounted?.close().catch(() => undefined)
  }
}

/**
 * The two questions the sweeps ask the control plane, and how long each answer may be believed.
 *
 * EXISTENCE is cached for the run. An agent can only stop existing, never start, so a cached
 * "still known" can be stale only in the direction that keeps objects — and a second read could
 * only ever turn a kept object into a collected one on a snapshot the first read contradicted.
 *
 * PLACEMENT is not cached, ever. It moves both ways: an agent that left can come back, and that is
 * precisely the answer a destructive pass must not hold a stale copy of. So every caller re-asks,
 * and the one that deletes re-asks again immediately before it does.
 */
function standingCache(read: ExistenceReader['readAgents']): {
  /** Every asked id the control plane still knows, wherever it is placed. Cached per run. */
  live: (agentIds: string[]) => Promise<Set<string>>
  /** Those of them this pool no longer holds, each with when its placement changed. Read fresh. */
  moved: (agentIds: string[]) => Promise<Map<string, number>>
} {
  const known = new Map<string, AgentStanding>()
  const ask = async (agentIds: string[]): Promise<Map<string, AgentStanding>> => {
    const answer = await read([...new Set(agentIds)])
    for (const [id, state] of answer) known.set(id, state)
    // An id the control plane did not name at all is gone; that is what the reply's silence means.
    for (const id of agentIds) if (!known.has(id)) known.set(id, { at: 'gone' })
    return answer
  }
  return {
    live: async (agentIds) => {
      const unknown = [...new Set(agentIds)].filter((id) => !known.has(id))
      if (unknown.length > 0) await ask(unknown)
      return new Set(agentIds.filter((id) => (known.get(id) ?? { at: 'gone' }).at !== 'gone'))
    },
    moved: async (agentIds) => {
      if (agentIds.length === 0) return new Map()
      const answer = await ask(agentIds)
      const moved = new Map<string, number>()
      for (const [id, state] of answer) if (state.at === 'elsewhere') moved.set(id, state.since)
      return moved
    }
  }
}

/**
 * Purge the expired sessions of agents this pool no longer holds.
 *
 * A member's own retention sweep is holder-only, because its active-turn exclusions are member-local
 * and only the holder can judge a row. That leaves exactly one set of rows unjudged: those of an
 * agent whose duty no member holds any more. Nobody here will ever serve them, and the daemon that
 * does hold the agent now reads a different store, so their sessions never expire and their pods and
 * volumes are never released. This is that judgement, made by the one process that can prove the
 * agent left: the same expiry rule, on the moved window rather than the install's retention one. It
 * is the store's half of the same decision the orphan sweep makes about that agent's claims — and
 * it is also the backstop for its session pods, whose claims live exactly as long as their rows.
 *
 * `deleteSession` writes the control plane's purge receipt in the same transaction, exactly as the
 * members' sweep does; no member of this pool will drain it, and it ages out on its own rule.
 */
async function purgeMovedAgentSessions(deps: {
  store: ReapableStore['store']
  movedAgents: (agentIds: string[]) => Promise<Map<string, number>>
  movedGraceMs: number
  deleteEnabled: boolean
  log: { info: (m: string) => void; warn: (m: string) => void }
}): Promise<{ failed: number }> {
  const { store, log } = deps
  if (!store.listExpiredSessions || !store.deleteSession) return { failed: 0 }
  const now = systemClock.now()
  let expired
  try {
    expired = await store.listExpiredSessions(now - deps.movedGraceMs)
  } catch (err) {
    log.warn(`moved sessions: listing expired sessions failed — ${(err as Error).message}`)
    return { failed: 1 }
  }
  if (expired.length === 0) return { failed: 0 }
  let moved: Map<string, number>
  try {
    moved = await deps.movedAgents([...new Set(expired.map((rec) => rec.agentId))])
  } catch (err) {
    log.warn(`moved sessions: could not ask which agents left this pool — ${(err as Error).message}`)
    return { failed: 1 }
  }
  // Both clocks, as the claim rule takes both: the departure itself must be past the window, and
  // the row must have gone untouched for it. An agent that left minutes ago keeps its sessions.
  const departed = (rec: { agentId: string }): boolean => {
    const since = moved.get(rec.agentId)
    return since !== undefined && now - since >= deps.movedGraceMs
  }
  const collectable = expired.filter(departed)
  let purged = 0
  let failed = 0
  if (collectable.length === 0) return { failed: 0 }
  // The same late re-read the claim sweep does, for the same reason: the answer above is a snapshot,
  // and a row purged after its agent came back takes the session's pod and volume with it on the next
  // sweep. An agent that left AGAIN reads as departed with a new timestamp and starts a fresh window.
  let confirmed: Map<string, number>
  try {
    confirmed = await deps.movedAgents([...new Set(collectable.map((rec) => rec.agentId))])
  } catch (err) {
    log.warn(`moved sessions: could not re-confirm which agents left this pool — ${(err as Error).message}`)
    return { failed: 1 }
  }
  const still = collectable.filter((rec) => confirmed.get(rec.agentId) === moved.get(rec.agentId))
  for (const rec of still) {
    if (!deps.deleteEnabled) {
      log.info(`moved sessions: would purge ${rec.key} (agent ${rec.agentId} left this pool) — dry run`)
      continue
    }
    try {
      if (await store.deleteSession(rec.key, { reason: 'retention', at: now })) purged += 1
    } catch (err) {
      failed += 1
      log.warn(`moved sessions: purging ${rec.key} failed — ${(err as Error).message}`)
    }
  }
  log.info(
    `moved sessions: ${still.length} expired session(s) of departed agents — purged=${purged} failed=${failed}` +
      (collectable.length > still.length ? `, ${collectable.length - still.length} left (agent came back)` : '') +
      (deps.deleteEnabled ? '' : ' (dry run)')
  )
  return { failed }
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
  let placedOnSetId: string | undefined
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
    // The pool this job sweeps for, as the control plane itself resolved it from this pod's identity.
    // Read at AUTH, because the observer registration that follows withdraws the membership again —
    // which is the point of an observer, and why there is nothing left to read it from afterwards.
    const setId = (auth.payload as AuthOk).memberSet?.setId
    const registered = await request('register', {
      host: 'reconcile',
      observer: true,
      capabilities: { platforms: [], runtimes: [], acp: false, features: [] },
      maxAgents: 0,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    })
    if (registered.type !== 'register/ok') throw new Error(`expected register/ok, got ${registered.type}`)
    // Asked only of a control plane that answers it: an older one would drop the field and report
    // every surviving agent as this pool's, which is the pre-placement sweep.
    placedOnSetId = (registered.payload as RegisterOk).serverFeatures.includes(AGENT_PLACEMENT_FEATURE)
      ? setId
      : undefined
  } catch (err) {
    correlator.rejectAll(new Error('observer registration failed'))
    transport.close(1011, 'observer registration failed')
    throw err
  }
  return {
    // Chunked at the frame's own cap; an error reply throws, which fails the sweep rather than
    // letting an unanswerable question read as "these agents are gone".
    readAgents: async (agentIds) => {
      const standing = new Map<string, AgentStanding>()
      for (let at = 0; at < agentIds.length; at += AGENT_EXISTS_MAX) {
        const reply = await request('agent/exists', {
          agentIds: agentIds.slice(at, at + AGENT_EXISTS_MAX),
          ...(placedOnSetId ? { placedOnSetId } : {})
        })
        if (reply.type !== 'agent/exists/ok') throw new Error(`expected agent/exists/ok, got ${reply.type}`)
        const payload = reply.payload as AgentExistsOk
        for (const id of payload.existing) standing.set(id, { at: 'here' })
        // Only an answered placement question moves an agent off this pool; an absent `elsewhere`
        // is "not answered", and reading it as "none left" is the same either way. A timestamp the
        // control plane sent but nobody can parse leaves the agent where it was: still this pool's.
        for (const row of payload.elsewhere ?? []) {
          const since = Date.parse(row.since)
          if (Number.isFinite(since)) standing.set(row.agentId, { at: 'elsewhere', since })
        }
      }
      return standing
    },
    close: () => {
      correlator.rejectAll(new Error('reconcile complete'))
      transport.close(1000, 'reconcile complete')
    }
  }
}
