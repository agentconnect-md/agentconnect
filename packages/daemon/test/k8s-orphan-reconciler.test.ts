import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import {
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  ORPHAN_DELETE_ENV,
  ORPHAN_GRACE_ENV,
  ORPHAN_SWEEP_INTERVAL_ENV,
  OrphanReconciler,
  resolveOrphanReconcilerSettings,
  type OrphanReconcilerDeps,
  type OrphanSweepSummary
} from '../src/k8s/orphan-reconciler.js'
import { AC_LABEL_AGENT, AC_LABEL_ORG } from '../src/k8s/driver.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, probeAgentId } from '../src/k8s/probe-claim.js'
import { SandboxApi, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'

/**
 * The orphan reconciler against a fake API server and a fake control-plane answer. The rules
 * under test are the safety rules: only a provably orphaned object goes, a live agent's never
 * does, grace is measured on this member's own sweeps as well as on the object's age, and the
 * default is to report rather than delete.
 */

afterEach(closeFakeApiServers)

const LIVE = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'
const JUST_GONE = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-08-14T10:00:00.000Z')
const HOUR = 60 * 60_000
const GRACE = 10 * 60_000

function claim(
  agentId: string,
  opts: { createdAt?: number; sandbox?: string; probeExpiresAt?: number } = {}
): SandboxClaim {
  const name = `agent-${agentId}`
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      resourceVersion: `rv-${name}`,
      creationTimestamp: new Date(opts.createdAt ?? T0 - HOUR).toISOString(),
      ...(opts.probeExpiresAt === undefined
        ? {}
        : {
            labels: { [PROBE_CLAIM_LABEL]: 'true' },
            annotations: { [PROBE_CLAIM_EXPIRES_ANNOTATION]: new Date(opts.probeExpiresAt).toISOString() }
          })
    },
    spec: {
      warmPoolRef: { name: 'pool' },
      additionalPodMetadata: { labels: { [AC_LABEL_ORG]: 'org-1', [AC_LABEL_AGENT]: agentId } }
    },
    ...(opts.sandbox ? { status: { sandbox: { name: opts.sandbox } } } : {})
  }
}

function sandbox(name: string, agentId?: string, createdAt = T0 - HOUR): Sandbox {
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      resourceVersion: `rv-${name}`,
      creationTimestamp: new Date(createdAt).toISOString()
    },
    spec: {
      operatingMode: 'Running',
      ...(agentId ? { podTemplate: { metadata: { labels: { [AC_LABEL_AGENT]: agentId } } } } : {})
    }
  }
}

/** A cluster holding `claims` and `sandboxes`, recording every delete with its preconditions. */
async function cluster(claims: SandboxClaim[], sandboxes: Sandbox[], opts: { sandboxList?: number } = {}) {
  const deletes: Array<{ path: string; preconditions: unknown }> = []
  const { config } = await fakeApiServer(({ method, url, body }) => {
    if (method === 'DELETE') {
      deletes.push({ path: url.pathname, preconditions: JSON.parse(body).preconditions })
      return { json: {} }
    }
    if (url.pathname.endsWith('/sandboxclaims')) return { json: { items: claims } }
    if (url.pathname.endsWith('/sandboxes')) {
      if (opts.sandboxList) return { status: opts.sandboxList, json: { kind: 'Status', reason: 'Forbidden' } }
      return { json: { items: sandboxes } }
    }
    return { status: 404, json: { kind: 'Status', reason: 'NotFound' } }
  })
  return { api: new SandboxApi(new K8sHttp(config), 'agent-sandboxes'), deletes }
}

function reconciler(over: Partial<OrphanReconcilerDeps> & { api: OrphanReconcilerDeps['api'] }) {
  const clock = new FakeClock(T0)
  const asked: string[][] = []
  const infos: string[] = []
  const warns: string[] = []
  const it = new OrphanReconciler({
    acquireLease: () => true,
    liveAgents: async (ids) => {
      asked.push(ids)
      return new Set(ids.filter((id) => id === LIVE))
    },
    settings: { intervalMs: DEFAULT_ORPHAN_SWEEP_INTERVAL_MS, graceMs: GRACE, deleteEnabled: true },
    clock,
    jitter: () => 0.5,
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m), debug: () => {} },
    ...over
  })
  return { it, clock, asked, infos, warns }
}

/** Two sweeps a grace apart: the shape every "past grace" case needs. */
async function twoSweeps(r: ReturnType<typeof reconciler>): Promise<OrphanSweepSummary | undefined> {
  await r.it.sweep()
  r.clock.advance(GRACE)
  return r.it.sweep()
}

describe('orphan reconciler settings', () => {
  it('defaults to a ten-minute jittered sweep, a ten-minute grace, and dry run', () => {
    expect(resolveOrphanReconcilerSettings({})).toEqual({
      intervalMs: DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
      graceMs: DEFAULT_ORPHAN_GRACE_MS,
      deleteEnabled: false
    })
    expect(
      resolveOrphanReconcilerSettings({
        [ORPHAN_SWEEP_INTERVAL_ENV]: '60000',
        [ORPHAN_GRACE_ENV]: '5000',
        [ORPHAN_DELETE_ENV]: 'true'
      })
    ).toEqual({ intervalMs: 60_000, graceMs: 5_000, deleteEnabled: true })
    expect(() => resolveOrphanReconcilerSettings({ [ORPHAN_GRACE_ENV]: '-1' })).toThrow(ORPHAN_GRACE_ENV)
  })
})

describe('orphan reconciler', () => {
  it('deletes a claim whose agent the control plane has forgotten, once past grace on both clocks', async () => {
    const { api, deletes } = await cluster(
      [claim(GONE, { sandbox: 'sb-gone' }), claim(LIVE, { sandbox: 'sb-live' })],
      []
    )
    const r = reconciler({ api })
    // First sight of the missing agent starts the grace; nothing goes yet.
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 0, skippedLive: 1, skippedGrace: 1 })
    expect(deletes).toEqual([])
    r.clock.advance(GRACE)
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 1, deleted: 1, skippedLive: 1, failed: 0 })
    // Exactly the incarnation that was listed, never a same-name replacement.
    expect(deletes).toEqual([
      {
        path: `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`,
        preconditions: { uid: `uid-agent-${GONE}`, resourceVersion: `rv-agent-${GONE}` }
      }
    ])
    // One existence read per sweep, covering every agent-bearing candidate at once.
    expect(r.asked).toEqual([
      [GONE, LIVE],
      [GONE, LIVE]
    ])
    expect(r.infos.at(-1)).toContain('orphaned=1 deleted=1 skipped-live=1 skipped-grace=0 failed=0')
  })

  it('never touches an object of a live agent, claimless Sandbox included', async () => {
    const { api, deletes } = await cluster([claim(LIVE, { sandbox: 'sb-live' })], [sandbox('sb-stray', LIVE)])
    const r = reconciler({ api })
    expect(await twoSweeps(r)).toMatchObject({ candidates: 2, orphaned: 0, deleted: 0, skippedLive: 2 })
    expect(deletes).toEqual([])
  })

  it('waits out the grace for an agent that only just went missing, even on an old object', async () => {
    const { api, deletes } = await cluster([claim(JUST_GONE)], [])
    const r = reconciler({ api })
    await r.it.sweep()
    r.clock.advance(GRACE - 1)
    expect(await r.it.sweep()).toMatchObject({ orphaned: 0, skippedGrace: 1 })
    expect(deletes).toEqual([])
    r.clock.advance(1)
    expect(await r.it.sweep()).toMatchObject({ orphaned: 1, deleted: 1 })
  })

  it('never collects an object whose age it cannot read', async () => {
    const undated = claim(GONE)
    delete undated.metadata?.creationTimestamp
    const { api, deletes } = await cluster([undated], [])
    const r = reconciler({ api })
    expect(await twoSweeps(r)).toMatchObject({ orphaned: 0, skippedGrace: 1 })
    expect(deletes).toEqual([])
  })

  it('only reports in dry run, which is the default', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [sandbox('sb-orphan', GONE)])
    const r = reconciler({ api, settings: { intervalMs: 60_000, graceMs: GRACE, deleteEnabled: false } })
    expect(await twoSweeps(r)).toMatchObject({ candidates: 2, orphaned: 2, deleted: 0 })
    expect(deletes).toEqual([])
    expect(r.infos.filter((m) => m.includes('would delete'))).toHaveLength(2)
    expect(r.infos.at(-1)).toContain('(dry run)')
  })

  it('collects a claimless Sandbox of a gone agent, and leaves bound and unlabelled ones alone', async () => {
    const { api, deletes } = await cluster(
      [claim(GONE, { sandbox: 'sb-bound' })],
      [sandbox('sb-bound', GONE), sandbox('sb-orphan', GONE), sandbox('warm-spare')]
    )
    const r = reconciler({ api })
    // Its claim will go, and the bound Sandbox with it through the claim; only the stray is a Sandbox delete.
    expect(await twoSweeps(r)).toMatchObject({ candidates: 2, orphaned: 2, deleted: 2 })
    expect(deletes.map((d) => d.path)).toEqual([
      `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`,
      '/apis/agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxes/sb-orphan'
    ])
  })

  it('collects expired probe claims by their own window and asks the control plane about none of them', async () => {
    const expired = probeAgentId('member-old')
    const running = probeAgentId('member-b')
    const { api, deletes } = await cluster(
      [claim(expired, { probeExpiresAt: T0 - 1 }), claim(running, { probeExpiresAt: T0 + HOUR })],
      []
    )
    const r = reconciler({ api })
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 1, deleted: 1, skippedGrace: 1 })
    expect(deletes.map((d) => d.path)).toEqual([
      `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${expired}`
    ])
    expect(r.asked).toEqual([])
  })

  it('sweeps only while holding the lease, and skips entirely when the control plane cannot answer', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [])
    const bystander = reconciler({ api, acquireLease: () => false })
    expect(await twoSweeps(bystander)).toBeUndefined()
    expect(bystander.asked).toEqual([])
    const unanswered = reconciler({
      api,
      liveAgents: async () => {
        throw new Error('control plane is not connected')
      }
    })
    expect(await twoSweeps(unanswered)).toBeUndefined()
    expect(unanswered.warns.at(-1)).toContain('sweep failed')
    expect(deletes).toEqual([])
  })

  it('narrows to claims when the Role does not allow listing Sandboxes', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [], { sandboxList: 403 })
    const r = reconciler({ api })
    expect(await twoSweeps(r)).toMatchObject({ candidates: 1, orphaned: 1, deleted: 1 })
    expect(deletes).toHaveLength(1)
    expect(r.warns.filter((m) => m.includes('not permitted'))).toHaveLength(1)
  })

  it('runs on a jittered interval and stops cleanly', async () => {
    const { api } = await cluster([], [])
    const r = reconciler({ api })
    r.it.start()
    expect(r.clock.pending).toBe(1)
    r.clock.advance(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(r.infos.filter((m) => m.includes('swept 0 candidates'))).toHaveLength(1)
    // Re-armed after the sweep, then disarmed by stop.
    expect(r.clock.pending).toBe(1)
    r.it.stop()
    expect(r.clock.pending).toBe(0)
  })
})
