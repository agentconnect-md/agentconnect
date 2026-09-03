import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import {
  DEFAULT_ORPHAN_GRACE_MS,
  ORPHAN_DELETE_ENV,
  ORPHAN_GRACE_ENV,
  OrphanReconciler,
  resolveOrphanReconcilerSettings,
  stampRefreshMsFor,
  type OrphanReconcilerDeps
} from '../src/k8s/orphan-reconciler.js'
import {
  AC_ANNOTATION_ADMITTED,
  AC_LABEL_AGENT,
  AC_LABEL_ORG,
  AC_LABEL_SESSION,
  sandboxClaimName,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL, probeAgentId } from '../src/k8s/probe-claim.js'
import { SandboxApi, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'

/**
 * The orphan reconciler against a fake API server and a fake control-plane answer. The rules
 * under test are the safety rules: one run collects only a provably orphaned object, a live
 * agent's is never touched, grace is the object's own age, and the default is to report.
 */

afterEach(closeFakeApiServers)

const LIVE = '11111111-1111-4111-8111-111111111111'
const GONE = '22222222-2222-4222-8222-222222222222'
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

/** A session pod's claim (git-workspace-model §11): the agent's label beside the session's, under the session's name. */
function sessionClaim(
  agentId: string,
  leaf: string,
  opts: { createdAt?: number; sandbox?: string; admittedAt?: number } = {}
): SandboxClaim {
  const name = sandboxClaimName(sessionSandboxSubject(agentId, leaf))
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      resourceVersion: `rv-${name}`,
      creationTimestamp: new Date(opts.createdAt ?? T0 - HOUR).toISOString(),
      ...(opts.admittedAt === undefined
        ? {}
        : { annotations: { [AC_ANNOTATION_ADMITTED]: new Date(opts.admittedAt).toISOString() } }),
      labels: { [AC_LABEL_ORG]: 'org-1', [AC_LABEL_AGENT]: agentId, [AC_LABEL_SESSION]: leaf }
    },
    spec: {
      warmPoolRef: { name: 'pool' },
      additionalPodMetadata: {
        labels: { [AC_LABEL_ORG]: 'org-1', [AC_LABEL_AGENT]: agentId, [AC_LABEL_SESSION]: leaf }
      }
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
async function cluster(
  claims: SandboxClaim[],
  sandboxes: Sandbox[],
  opts: { sandboxList?: number; deleteConflict?: boolean } = {}
) {
  const deletes: Array<{ path: string; preconditions: unknown }> = []
  const { config } = await fakeApiServer(({ method, url, body }) => {
    if (method === 'DELETE') {
      deletes.push({ path: url.pathname, preconditions: JSON.parse(body).preconditions })
      // What the API server answers when the object's version moved since it was listed.
      if (opts.deleteConflict) return { status: 409, json: { kind: 'Status', reason: 'Conflict' } }
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
    liveAgents: async (ids) => {
      asked.push(ids)
      return new Set(ids.filter((id) => id === LIVE))
    },
    settings: { graceMs: GRACE, deleteEnabled: true },
    clock,
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m), debug: () => {} },
    ...over
  })
  return { it, clock, asked, infos, warns }
}

describe('orphan reconciler settings', () => {
  it('defaults to a ten-minute grace and dry run', () => {
    expect(resolveOrphanReconcilerSettings({})).toEqual({
      graceMs: DEFAULT_ORPHAN_GRACE_MS,
      deleteEnabled: false
    })
    expect(resolveOrphanReconcilerSettings({ [ORPHAN_GRACE_ENV]: '5000', [ORPHAN_DELETE_ENV]: 'true' })).toEqual({
      graceMs: 5_000,
      deleteEnabled: true
    })
    expect(() => resolveOrphanReconcilerSettings({ [ORPHAN_GRACE_ENV]: '-1' })).toThrow(ORPHAN_GRACE_ENV)
  })

  it('derives the members’ stamp cadence from whatever grace the sweep was given', () => {
    // One safety window: the sweep collects a claim nothing has touched for `graceMs`, so a member using
    // one has to touch it strictly more often than that. A fixed cadence is silently wrong for every
    // install that shortens the grace — a held claim would age past it between two ticks and become
    // deletable while in use — so the cadence tracks the configured value rather than a constant.
    for (const graceMs of [DEFAULT_ORPHAN_GRACE_MS, 90_000, 30_000, 5_000, 1_000]) {
      const refreshMs = stampRefreshMsFor(graceMs)
      expect(refreshMs).toBeGreaterThan(0)
      // Two missed ticks still leave a held claim inside the window.
      expect(refreshMs * 3).toBeLessThanOrEqual(graceMs)
    }
    expect(stampRefreshMsFor(DEFAULT_ORPHAN_GRACE_MS)).toBe(200_000)
    // A grace shorter than the cadence it used to be hardcoded at is the case that was broken.
    expect(stampRefreshMsFor(90_000)).toBe(30_000)
  })
})

describe('orphan reconciler', () => {
  it('deletes a claim whose agent the control plane has forgotten, in one run', async () => {
    const { api, deletes } = await cluster(
      [claim(GONE, { sandbox: 'sb-gone' }), claim(LIVE, { sandbox: 'sb-live' })],
      []
    )
    const r = reconciler({ api })
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 1, deleted: 1, skippedLive: 1, failed: 0 })
    // Exactly the incarnation that was listed, never a same-name replacement.
    expect(deletes).toEqual([
      {
        path: `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`,
        preconditions: { uid: `uid-agent-${GONE}`, resourceVersion: `rv-agent-${GONE}` }
      }
    ])
    // One existence read per run, covering every agent-bearing candidate at once.
    expect(r.asked).toEqual([[GONE, LIVE]])
    expect(r.infos.at(-1)).toContain('orphaned=1 deleted=1 skipped-live=1 skipped-grace=0 failed=0')
  })

  it('never touches an object of a live agent, claimless Sandbox included', async () => {
    const { api, deletes } = await cluster([claim(LIVE, { sandbox: 'sb-live' })], [sandbox('sb-stray', LIVE)])
    const r = reconciler({ api })
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 0, deleted: 0, skippedLive: 2 })
    expect(deletes).toEqual([])
  })

  it('leaves an object younger than the grace alone', async () => {
    const { api, deletes } = await cluster([claim(GONE, { createdAt: T0 - GRACE + 1 })], [])
    const r = reconciler({ api })
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
    expect(await r.it.sweep()).toMatchObject({ orphaned: 0, skippedGrace: 1 })
    expect(deletes).toEqual([])
  })

  it('only reports in dry run, which is the default', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [sandbox('sb-orphan', GONE)])
    const r = reconciler({ api, settings: { graceMs: GRACE, deleteEnabled: false } })
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 2, deleted: 0 })
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
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 2, deleted: 2 })
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

  it('fails the whole sweep when the control plane cannot answer', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [])
    const unanswered = reconciler({
      api,
      liveAgents: async () => {
        throw new Error('control plane is not connected')
      }
    })
    expect(await unanswered.it.sweep()).toBeUndefined()
    expect(unanswered.warns.at(-1)).toContain('sweep failed')
    expect(deletes).toEqual([])
  })

  it('narrows to claims when the Role does not allow listing Sandboxes', async () => {
    const { api, deletes } = await cluster([claim(GONE)], [], { sandboxList: 403 })
    const r = reconciler({ api })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 1, deleted: 1 })
    expect(deletes).toHaveLength(1)
    expect(r.warns.filter((m) => m.includes('not permitted'))).toHaveLength(1)
  })
})

describe('orphan reconciler and session pods (git-workspace-model §11)', () => {
  const KEPT = 'session-aaaaaaaaaaaaaaaaaaaaaaaa'
  const GONE_LEAF = 'session-bbbbbbbbbbbbbbbbbbbbbbbb'
  const claimPath = (agentId: string, leaf: string) =>
    `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/${sandboxClaimName(sessionSandboxSubject(agentId, leaf))}`

  it("collects a live agent's session pod whose row is gone, keeps the one whose row remains and the agent's own", async () => {
    const { api, deletes } = await cluster(
      [
        claim(LIVE, { sandbox: 'sb-live' }),
        sessionClaim(LIVE, KEPT, { sandbox: 'sb-kept' }),
        sessionClaim(LIVE, GONE_LEAF, { sandbox: 'sb-gone' })
      ],
      // A claimless Sandbox with a session label answers to the same rule.
      [sandbox('sb-stray', LIVE), withSessionLabel(sandbox('sb-stray-session', LIVE), GONE_LEAF)]
    )
    const askedSessions: Array<{ agentId: string; leaf: string }>[] = []
    const r = reconciler({
      api,
      liveSessionLeaves: async (sessions) => {
        askedSessions.push(sessions)
        return new Set([sessionSandboxSubject(LIVE, KEPT)])
      }
    })
    expect(await r.it.sweep()).toMatchObject({ candidates: 5, orphaned: 2, deleted: 2, skippedLive: 3, failed: 0 })
    expect(deletes.map((entry) => entry.path)).toEqual([
      claimPath(LIVE, GONE_LEAF),
      '/apis/agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxes/sb-stray-session'
    ])
    // One question per run, about the session pods of live agents only, and never about the agent's own pod.
    expect(askedSessions).toEqual([
      [
        { agentId: LIVE, leaf: KEPT },
        { agentId: LIVE, leaf: GONE_LEAF },
        { agentId: LIVE, leaf: GONE_LEAF }
      ]
    ])
    expect(r.infos.some((line) => line.includes(`session ${GONE_LEAF}`))).toBe(true)
  })

  it('reads a session pod as live when nothing can answer for its session', async () => {
    const { api, deletes } = await cluster([sessionClaim(LIVE, GONE_LEAF, { sandbox: 'sb-gone' })], [])
    const r = reconciler({ api })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 0, deleted: 0, skippedLive: 1 })
    expect(deletes).toEqual([])
  })

  it('reads every session pod as live when the store will not answer, and still sweeps the rest', async () => {
    const { api, deletes } = await cluster(
      [sessionClaim(LIVE, GONE_LEAF, { sandbox: 'sb-gone' }), claim(GONE, { sandbox: 'sb-agent-gone' })],
      []
    )
    const r = reconciler({
      api,
      liveSessionLeaves: async () => {
        throw new Error('store unreachable')
      }
    })
    expect(await r.it.sweep()).toMatchObject({ candidates: 2, orphaned: 1, deleted: 1, skippedLive: 1, failed: 0 })
    expect(deletes.map((entry) => entry.path)).toEqual([
      `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/agent-sandboxes/sandboxclaims/agent-${GONE}`
    ])
    expect(r.warns.some((line) => line.includes('keeping every session pod'))).toBe(true)
  })

  it("collects a gone agent's session pod on the agent rule alone, asking about no sessions", async () => {
    const { api, deletes } = await cluster([sessionClaim(GONE, KEPT, { sandbox: 'sb-gone' })], [])
    const askedSessions: unknown[] = []
    const r = reconciler({
      api,
      liveSessionLeaves: async (sessions) => {
        askedSessions.push(sessions)
        return new Set()
      }
    })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 1, deleted: 1 })
    expect(deletes.map((entry) => entry.path)).toEqual([claimPath(GONE, KEPT)])
    expect(askedSessions).toEqual([])
  })

  it('runs the grace from the admission stamp, so a re-admitted leaked claim is young again', async () => {
    // The object's own age cannot fence this: the claim IS old — it leaked — and the session that came
    // back reuses it rather than creating one. Admission stamping it is what makes the age honest.
    const { api, deletes } = await cluster(
      [sessionClaim(LIVE, GONE_LEAF, { createdAt: T0 - HOUR, admittedAt: T0 - GRACE + 1 })],
      []
    )
    const r = reconciler({ api, liveSessionLeaves: async () => new Set() })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 0, deleted: 0, skippedGrace: 1 })
    expect(deletes).toEqual([])

    // And once nothing has admitted it for a whole grace, it is collectable again.
    r.clock.advance(1)
    expect(await r.it.sweep()).toMatchObject({ orphaned: 1, deleted: 1 })
  })

  it('loses the delete to an admission that landed after the listing, rather than taking a live pod', async () => {
    // The absence proof is a snapshot: the row can come back, and `ensureClaim` reuse it, between the
    // list above and the delete below. The admission's own write moves the claim's resourceVersion, so
    // the preconditioned delete is refused — the pod and its volume stay, and the next run re-decides.
    const { api, deletes } = await cluster([sessionClaim(LIVE, GONE_LEAF, { sandbox: 'sb-gone' })], [], {
      deleteConflict: true
    })
    const r = reconciler({ api, liveSessionLeaves: async () => new Set() })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 1, deleted: 0, failed: 0 })
    // Fenced on the version it listed, which is the only reason the admission can win.
    expect(deletes).toEqual([
      {
        path: claimPath(LIVE, GONE_LEAF),
        preconditions: {
          uid: `uid-${sandboxClaimName(sessionSandboxSubject(LIVE, GONE_LEAF))}`,
          resourceVersion: `rv-${sandboxClaimName(sessionSandboxSubject(LIVE, GONE_LEAF))}`
        }
      }
    ])
    expect(r.infos.some((line) => line.includes('was replaced since it was listed'))).toBe(true)
  })

  it("leaves a live agent's young session pod alone even when its row is gone", async () => {
    const { api, deletes } = await cluster([sessionClaim(LIVE, GONE_LEAF, { createdAt: T0 - GRACE + 1 })], [])
    const r = reconciler({ api, liveSessionLeaves: async () => new Set() })
    expect(await r.it.sweep()).toMatchObject({ candidates: 1, orphaned: 0, skippedGrace: 1 })
    expect(deletes).toEqual([])
  })
})

/** The same Sandbox, carrying a session label on its pod template the way the controller propagates it. */
function withSessionLabel(object: Sandbox, leaf: string): Sandbox {
  return {
    ...object,
    spec: {
      ...object.spec,
      podTemplate: {
        ...object.spec?.podTemplate,
        metadata: { labels: { ...object.spec?.podTemplate?.metadata?.labels, [AC_LABEL_SESSION]: leaf } }
      }
    }
  }
}
