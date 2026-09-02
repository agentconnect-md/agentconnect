/**
 * `agentconnect-daemon reconcile --once` — the CronJob's whole job: connect as an OBSERVER, run
 * one sweep against the sandbox namespace, print the summary, and exit 0 (non-zero on failure).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { buildEnvelope, decodeEnvelope, encode, type AnyFrame } from '@agentconnect.md/protocol'
import {
  AC_LABEL_AGENT,
  AC_LABEL_ORG,
  AC_LABEL_SESSION,
  sandboxClaimName,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { SandboxApi, type SandboxClaim } from '../src/k8s/sandbox-api.js'
import { ORPHAN_DELETE_ENV } from '../src/k8s/orphan-reconciler.js'
import { STORE_ORPHAN_DELETE_ENV } from '../src/store/retention.js'
import type { StoreRetentionCandidate, StoreRetentionRule } from '../src/store/retention.js'
import { K8S_SANDBOX_NAMESPACE_ENV } from '../src/k8s/runtime-plane.js'
import { connectObserver, runReconcileOnce, type ExistenceReader } from '../src/cli/reconcile.js'
import { FakeTransport } from './cp/fake-transport.js'

afterEach(closeFakeApiServers)

const LIVE = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'
const OLD = new Date(Date.now() - 60 * 60_000).toISOString()

function claim(agentId: string): SandboxClaim {
  const name = `agent-${agentId}`
  return {
    metadata: { name, uid: `uid-${name}`, resourceVersion: `rv-${name}`, creationTimestamp: OLD },
    spec: {
      warmPoolRef: { name: 'pool' },
      additionalPodMetadata: { labels: { [AC_LABEL_ORG]: 'org-1', [AC_LABEL_AGENT]: agentId } }
    }
  }
}

/** A live agent's session pod claim (git-workspace-model §11), by the session key its row would carry. */
function sessionClaim(agentId: string, sessionKey: string): SandboxClaim {
  const leaf = hostKeyDirName(sessionHostKey(agentId, sessionKey))
  const name = sandboxClaimName(sessionSandboxSubject(agentId, leaf))
  const labels = { [AC_LABEL_ORG]: 'org-1', [AC_LABEL_AGENT]: agentId, [AC_LABEL_SESSION]: leaf }
  return {
    metadata: { name, uid: `uid-${name}`, resourceVersion: `rv-${name}`, creationTimestamp: OLD, labels },
    spec: { warmPoolRef: { name: 'pool' }, additionalPodMetadata: { labels } }
  }
}

/** A cluster holding two claims — one of a live agent, one of a forgotten one — plus any extra. */
async function cluster(opts: { deleteStatus?: number; extraClaims?: SandboxClaim[] } = {}) {
  const deletes: string[] = []
  const { config } = await fakeApiServer(({ method, url }) => {
    if (method === 'DELETE') {
      deletes.push(url.pathname)
      if (opts.deleteStatus) return { status: opts.deleteStatus, json: { kind: 'Status', reason: 'Forbidden' } }
      return { json: {} }
    }
    if (url.pathname.endsWith('/sandboxclaims')) {
      return { json: { items: [claim(LIVE), claim(GONE), ...(opts.extraClaims ?? [])] } }
    }
    if (url.pathname.endsWith('/sandboxes')) return { json: { items: [] } }
    return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
  })
  return { api: new SandboxApi(new K8sHttp(config), 'agent-sandboxes'), deletes }
}

/** A control plane that knows only `LIVE`, recording what the sweep asked it. */
function fakeCp() {
  const asked: string[][] = []
  let closed = false
  const connectCp = async (): Promise<ExistenceReader> => ({
    liveAgents: async (ids: string[]) => {
      asked.push(ids)
      return new Set(ids.filter((id) => id === LIVE))
    },
    close: () => {
      closed = true
    }
  })
  return { connectCp, asked, wasClosed: () => closed }
}

describe('reconcile --once', () => {
  it('runs one sweep, prints the summary, and exits 0', async () => {
    const { api, deletes } = await cluster()
    const cp = fakeCp()
    const infos: string[] = []
    const code = await runReconcileOnce({
      api,
      connectCp: cp.connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true' },
      log: { info: (m) => infos.push(m), warn: (m) => infos.push(m) }
    })
    expect(code).toBe(0)
    expect(cp.asked).toEqual([[LIVE, GONE]])
    expect(deletes).toEqual([
      `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`
    ])
    expect(infos.at(-1)).toContain('swept 2 candidates — orphaned=1 deleted=1 skipped-live=1')
    // The connection is one-shot: closed whatever the sweep decided.
    expect(cp.wasClosed()).toBe(true)
  })

  it('sweeps the shared store in the same run, on the same control-plane answer', async () => {
    // One CronJob covers both halves because they ask the same question: `agent/exists` decides
    // whether a SandboxClaim and an outbox row alike are leaked.
    const { api } = await cluster()
    const cp = fakeCp()
    const infos: string[] = []
    const deleted: string[] = []
    let closed = false
    const code = await runReconcileOnce({
      api,
      connectCp: cp.connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true', [STORE_ORPHAN_DELETE_ENV]: 'true' },
      openStore: async () => ({
        store: storeOf({ 'session-purge': GONE, 'hook-report': LIVE }, deleted),
        close: async () => {
          closed = true
        }
      }),
      log: { info: (m) => infos.push(m), warn: (m) => infos.push(m) }
    })
    expect(code).toBe(0)
    expect(cp.asked).toEqual([
      [LIVE, GONE],
      [LIVE, GONE]
    ])
    expect(deleted).toEqual(['row-session-purge'])
    expect(infos.at(-1)).toContain('store retention: swept 2 candidates — collected=1 deleted=1 kept=1 failed=0')
    expect(infos.at(-1)).toContain('agent-gone=1 horizon=0')
    expect(infos.at(-1)).toContain('session-purge=1')
    expect(closed).toBe(true)
  })

  it('asks the shared store which session pods still have a row, and collects the rest (§11)', async () => {
    const kept = 'slack:C1:T-kept:agent'
    const gone = 'slack:C1:T-gone:agent'
    const { api, deletes } = await cluster({ extraClaims: [sessionClaim(LIVE, kept), sessionClaim(LIVE, gone)] })
    const asked: string[] = []
    const code = await runReconcileOnce({
      api,
      connectCp: fakeCp().connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true' },
      openStore: async () => ({
        store: {
          ...storeOf({}, []),
          sessionKeysForAgent: async (agentId: string) => {
            asked.push(agentId)
            return agentId === LIVE ? [kept] : []
          }
        },
        close: async () => undefined
      }),
      log: { info: () => {}, warn: () => {} }
    })
    expect(code).toBe(0)
    expect(asked).toEqual([LIVE])
    const claims = '/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims'
    expect(deletes.sort()).toEqual(
      [
        `${claims}/agent-${GONE}`,
        `${claims}/${sandboxClaimName(sessionSandboxSubject(LIVE, hostKeyDirName(sessionHostKey(LIVE, gone))))}`
      ].sort()
    )
  })

  it('keeps every session pod when no shared store is mounted to answer for its row', async () => {
    const { api, deletes } = await cluster({ extraClaims: [sessionClaim(LIVE, 'slack:C1:T-any:agent')] })
    const code = await runReconcileOnce({
      api,
      connectCp: fakeCp().connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true' },
      openStore: async () => undefined,
      log: { info: () => {}, warn: () => {} }
    })
    expect(code).toBe(0)
    expect(deletes).toEqual([
      `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`
    ])
  })

  it('exits 1 when the store sweep left an orphan behind, however clean the cluster was', async () => {
    const { api } = await cluster()
    const code = await runReconcileOnce({
      api,
      connectCp: fakeCp().connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true', [STORE_ORPHAN_DELETE_ENV]: 'true' },
      openStore: async () => ({
        store: {
          listRetentionCandidates: async (rule: StoreRetentionRule) =>
            rule.id === 'session-purge' ? [candidate(rule, GONE)] : [],
          deleteRetentionRow: async () => {
            throw new Error('deadlock detected')
          }
        },
        close: async () => undefined
      }),
      log: { info: () => {}, warn: () => {} }
    })
    expect(code).toBe(1)
  })

  it('exits 1 when a delete failed, after reporting the whole sweep', async () => {
    // The failure is counted rather than thrown, so the run still says what it found — but an
    // orphan it could not collect will be back next run, and a green Job would hide that.
    const { api, deletes } = await cluster({ deleteStatus: 403 })
    const logged: string[] = []
    const code = await runReconcileOnce({
      api,
      connectCp: fakeCp().connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: { [ORPHAN_DELETE_ENV]: 'true' },
      log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) }
    })
    expect(code).toBe(1)
    expect(deletes).toHaveLength(1)
    expect(logged.at(-1)).toContain('orphaned=1 deleted=0 skipped-live=1 skipped-grace=0 failed=1')
  })

  it('exits 1 when the control plane cannot be reached, deleting nothing', async () => {
    const { api, deletes } = await cluster()
    const warns: string[] = []
    const code = await runReconcileOnce({
      api,
      connectCp: async () => {
        throw new Error('connection refused')
      },
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: {},
      log: { info: () => {}, warn: (m) => warns.push(m) }
    })
    expect(code).toBe(1)
    expect(deletes).toEqual([])
    expect(warns.at(-1)).toContain('connection refused')
  })

  it('exits 1 without the sandbox namespace the pool member reads', async () => {
    const warns: string[] = []
    const code = await runReconcileOnce({
      connectCp: fakeCp().connectCp,
      apiUrl: 'wss://cp.example.test/daemon/ws',
      env: {},
      log: { info: () => {}, warn: (m) => warns.push(m) }
    })
    expect(code).toBe(1)
    expect(warns.at(-1)).toContain(K8S_SANDBOX_NAMESPACE_ENV)
  })
})

/** Auto-reply to whatever the observer asks, recording the frames it sent. */
function scriptedCp(over: Partial<Record<string, (frame: AnyFrame) => { type: string; payload: unknown }>> = {}) {
  const transport = new FakeTransport()
  const sent: AnyFrame[] = []
  const answers: Record<string, (frame: AnyFrame) => { type: string; payload: unknown }> = {
    auth: () => ({
      type: 'auth/ok',
      payload: {
        daemonId: GONE,
        sessionEpoch: 1,
        heartbeatSec: 15,
        serverTime: new Date().toISOString(),
        organizationMode: 'frame'
      }
    }),
    register: () => ({
      type: 'register/ok',
      payload: {
        routingEpoch: 1,
        assignments: [],
        crons: [],
        leases: [],
        drop: { assignments: [], crons: [] }
      }
    }),
    'agent/exists': (frame) => ({
      type: 'agent/exists/ok',
      payload: { existing: (frame.payload as { agentIds: string[] }).agentIds.filter((id) => id === LIVE) }
    }),
    ...over
  }
  const originalSend = transport.send.bind(transport)
  transport.send = (text: string) => {
    originalSend(text)
    const decoded = decodeEnvelope(text)
    if (!decoded.ok) return
    sent.push(decoded.frame)
    const answer = answers[decoded.frame.type]
    if (!answer) return
    const { type, payload } = answer(decoded.frame)
    queueMicrotask(() =>
      transport.pushInbound(encode(buildEnvelope(type as never, payload, { corr: decoded.frame.id })))
    )
  }
  return { transport, sent }
}

describe('observer connection', () => {
  it('registers with observer set, then asks only about agent existence', async () => {
    const { transport, sent } = scriptedCp()
    const cp = await connectObserver('wss://cp.example.test/daemon/ws', {
      dial: async () => transport,
      token: () => 'projected-token'
    })
    expect(sent.map((f) => f.type)).toEqual(['auth', 'register'])
    expect((sent[0]!.payload as { serviceAccountToken: string }).serviceAccountToken).toBe('projected-token')
    expect(sent[1]!.payload).toMatchObject({ observer: true, maxAgents: 0 })

    expect(await cp.liveAgents([LIVE, GONE])).toEqual(new Set([LIVE]))
    cp.close()
    expect(transport.closed?.code).toBe(1000)
  })

  it('fails the connection when the control plane refuses the observer registration', async () => {
    const { transport } = scriptedCp({
      register: () => ({ type: 'error', payload: { code: 'SCOPE_DENIED', message: 'nope', retryable: false } })
    })
    await expect(
      connectObserver('wss://cp.example.test/daemon/ws', { dial: async () => transport, token: () => 'tok' })
    ).rejects.toThrow()
    expect(transport.closed?.code).toBe(1011)
  })

  it('refuses to connect without a projected identity token', async () => {
    const { transport } = scriptedCp()
    await expect(
      connectObserver('wss://cp.example.test/daemon/ws', { dial: async () => transport, token: () => undefined })
    ).rejects.toThrow('identity token')
  })
})

/** One fresh candidate per rule, so only the control-plane answer decides what is collected. */
const candidate = (rule: StoreRetentionRule, agentId: string): StoreRetentionCandidate => ({
  key: Object.fromEntries(rule.key.map((column) => [column, `row-${rule.id}`])),
  agentId,
  touchedAt: Date.now()
})

/** A store holding exactly the named rules' rows, recording what the sweep deleted. */
function storeOf(rows: Record<string, string>, deleted: string[]) {
  return {
    listRetentionCandidates: async (rule: StoreRetentionRule) =>
      rows[rule.id] ? [candidate(rule, rows[rule.id]!)] : [],
    deleteRetentionRow: async (rule: StoreRetentionRule) => {
      deleted.push(`row-${rule.id}`)
      return true
    }
  }
}
