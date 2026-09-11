import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import {
  DEFAULT_IDLE_VOLUME_MS,
  IDLE_VOLUME_DELETE_ENV,
  IDLE_VOLUME_WINDOW_ENV,
  IdleVolumeReaper,
  resolveIdleVolumeReaperSettings,
  type IdleVolumeReaperDeps
} from '../src/k8s/idle-volume-reaper.js'
import {
  AC_ANNOTATION_ADMITTED,
  AC_LABEL_AGENT,
  AC_LABEL_ORG,
  AC_LABEL_SESSION,
  sandboxClaimName,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import { PROBE_CLAIM_EXPIRES_ANNOTATION, PROBE_CLAIM_LABEL } from '../src/k8s/probe-claim.js'
import { SandboxApi, type OperatingMode, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'

/**
 * The idle-volume reaper against a fake API server and a fake store answer. What is under test is
 * the four-part proof: an agent pod's claim, a suspended Sandbox, no session row anywhere, and an
 * object older than the window — plus the fail-closed behaviour when any of those cannot be read.
 */

afterEach(closeFakeApiServers)

const IDLE = '11111111-1111-4111-8111-111111111111'
const BUSY = '22222222-2222-4222-8222-222222222222'
const T0 = Date.parse('2026-09-11T10:00:00.000Z')
const DAY = 24 * 60 * 60_000
const WINDOW = 7 * DAY

function claim(
  agentId: string,
  opts: { createdAt?: number; sandbox?: string; leaf?: string; probeExpiresAt?: number; admittedAt?: number } = {}
): SandboxClaim {
  const subject = opts.leaf === undefined ? agentId : sessionSandboxSubject(agentId, opts.leaf)
  const name = opts.leaf === undefined ? `agent-${agentId}` : sandboxClaimName(subject)
  const labels = {
    [AC_LABEL_ORG]: 'org-1',
    [AC_LABEL_AGENT]: agentId,
    ...(opts.leaf === undefined ? {} : { [AC_LABEL_SESSION]: opts.leaf })
  }
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      resourceVersion: `rv-${name}`,
      creationTimestamp: new Date(opts.createdAt ?? T0 - 30 * DAY).toISOString(),
      ...(opts.probeExpiresAt === undefined
        ? {}
        : {
            labels: { [PROBE_CLAIM_LABEL]: 'true' },
            annotations: { [PROBE_CLAIM_EXPIRES_ANNOTATION]: new Date(opts.probeExpiresAt).toISOString() }
          }),
      ...(opts.admittedAt === undefined
        ? {}
        : { annotations: { [AC_ANNOTATION_ADMITTED]: new Date(opts.admittedAt).toISOString() } })
    },
    spec: { warmPoolRef: { name: 'pool' }, additionalPodMetadata: { labels } },
    status: { sandbox: { name: opts.sandbox ?? `pool-${agentId.slice(0, 5)}${opts.leaf ?? ''}` } }
  }
}

function sandbox(name: string, operatingMode: OperatingMode = 'Suspended'): Sandbox {
  return { metadata: { name, uid: `uid-${name}`, resourceVersion: `rv-${name}` }, spec: { operatingMode } }
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

function reaper(over: Partial<IdleVolumeReaperDeps> & { api: IdleVolumeReaperDeps['api'] }) {
  const asked: string[][] = []
  const infos: string[] = []
  const warns: string[] = []
  const it = new IdleVolumeReaper({
    agentsWithSessions: async (ids) => {
      asked.push(ids)
      return new Set(ids.filter((id) => id === BUSY))
    },
    settings: { windowMs: WINDOW, deleteEnabled: true },
    clock: new FakeClock(T0),
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m), debug: () => {} },
    ...over
  })
  return { it, asked, infos, warns }
}

describe('idle volume reaper settings', () => {
  it('defaults to a seven-day window and dry run', () => {
    expect(resolveIdleVolumeReaperSettings({})).toEqual({
      windowMs: DEFAULT_IDLE_VOLUME_MS,
      deleteEnabled: false
    })
    expect(DEFAULT_IDLE_VOLUME_MS).toBe(WINDOW)
    expect(
      resolveIdleVolumeReaperSettings({ [IDLE_VOLUME_WINDOW_ENV]: '5000', [IDLE_VOLUME_DELETE_ENV]: 'true' })
    ).toEqual({ windowMs: 5_000, deleteEnabled: true })
    expect(() => resolveIdleVolumeReaperSettings({ [IDLE_VOLUME_WINDOW_ENV]: '0' })).toThrow(IDLE_VOLUME_WINDOW_ENV)
  })
})

describe('idle volume reaper', () => {
  it('collects a suspended agent volume whose sessions are all gone, fenced on the listed version', async () => {
    const { api, deletes } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle')])
    const { it: r, infos } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ candidates: 1, idle: 1, deleted: 1, failed: 0 })
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.path).toContain(`agent-${IDLE}`)
    // Admission and collection share one object version: a wake that landed after the listing
    // moves the claim's resourceVersion and makes this delete fail instead of taking the volume.
    expect(deletes[0]!.preconditions).toEqual({ uid: `uid-agent-${IDLE}`, resourceVersion: `rv-agent-${IDLE}` })
    expect(infos.some((m) => m.includes('with its volume'))).toBe(true)
  })

  it('keeps the volume of an agent that still has any session row', async () => {
    const { api, deletes } = await cluster([claim(BUSY, { sandbox: 'sb-busy' })], [sandbox('sb-busy')])
    const { it: r, asked } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ candidates: 1, idle: 0, skippedSessions: 1, deleted: 0 })
    expect(asked).toEqual([[BUSY]])
    expect(deletes).toEqual([])
  })

  it('keeps a volume whose sandbox is awake, whatever the rows say', async () => {
    const { api, deletes } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle', 'Running')])
    const { it: r } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 0, skippedAwake: 1, deleted: 0 })
    expect(deletes).toEqual([])
  })

  it('keeps a claim younger than the window, and never reads the store for it', async () => {
    const { api, deletes } = await cluster(
      [claim(IDLE, { createdAt: T0 - 6 * DAY, sandbox: 'sb-idle' })],
      [sandbox('sb-idle')]
    )
    const { it: r, asked } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 0, skippedRecent: 1, deleted: 0 })
    expect(asked).toEqual([])
    expect(deletes).toEqual([])
  })

  it('ignores the admission stamp: a rollout re-stamps every claim it adopts', async () => {
    // The orphan sweep ages a claim from the LATER of creation and last admission. Here that would
    // mean a deploy an hour ago resets every agent's idle clock and the window never elapses.
    const { api, deletes } = await cluster(
      [claim(IDLE, { sandbox: 'sb-idle', admittedAt: T0 - 60 * 60_000 })],
      [sandbox('sb-idle')]
    )
    const { it: r } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 1, deleted: 1 })
    expect(deletes).toHaveLength(1)
  })

  it('leaves session pods and probe claims to the sweeps that own them', async () => {
    const { api, deletes } = await cluster(
      [
        claim(IDLE, { leaf: 'session-abc', sandbox: 'sb-session' }),
        claim('probe-local', { probeExpiresAt: T0 - DAY, sandbox: 'sb-probe' })
      ],
      [sandbox('sb-session'), sandbox('sb-probe')]
    )
    const { it: r } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ candidates: 0, idle: 0, deleted: 0 })
    expect(deletes).toEqual([])
  })

  it('a surviving session pod of the same agent vetoes the agent volume', async () => {
    // Its row may be exactly the one retention refused to delete over unpushed work, and the
    // legacy worktree that holds that work lives on the AGENT volume (git-workspace-model §11).
    const { api, deletes } = await cluster(
      [claim(IDLE, { sandbox: 'sb-idle' }), claim(IDLE, { leaf: 'session-abc', sandbox: 'sb-session' })],
      [sandbox('sb-idle'), sandbox('sb-session')]
    )
    const { it: r } = reaper({ api, agentsWithSessions: async () => new Set() })
    await expect(r.sweep()).resolves.toMatchObject({ candidates: 1, idle: 0, skippedSessions: 1, deleted: 0 })
    expect(deletes).toEqual([])
  })

  it('collects nothing without a store to ask, and nothing when the store will not answer', async () => {
    const { api, deletes } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle')])
    const noStore = reaper({ api, agentsWithSessions: undefined })
    await expect(noStore.it.sweep()).resolves.toMatchObject({ idle: 0, skippedSessions: 1, deleted: 0 })
    const broken = reaper({
      api,
      agentsWithSessions: async () => {
        throw new Error('data plane is down')
      }
    })
    await expect(broken.it.sweep()).resolves.toMatchObject({ idle: 0, skippedSessions: 1, deleted: 0 })
    expect(broken.warns.some((m) => m.includes('keeping every volume'))).toBe(true)
    expect(deletes).toEqual([])
  })

  it('proves nothing idle when listing sandboxes is not permitted', async () => {
    const { api, deletes } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle')], {
      sandboxList: 403
    })
    const { it: r, warns } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 0, skippedAwake: 1, deleted: 0 })
    expect(warns.some((m) => m.includes('not permitted'))).toBe(true)
    expect(deletes).toEqual([])
  })

  it('reports without deleting on a dry run', async () => {
    const { api, deletes } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle')])
    const { it: r, infos } = reaper({ api, settings: { windowMs: WINDOW, deleteEnabled: false } })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 1, deleted: 0 })
    expect(deletes).toEqual([])
    expect(infos.some((m) => m.includes('would delete') && m.includes('30d'))).toBe(true)
    expect(infos.at(-1)).toContain('(dry run)')
  })

  it('counts a claim used since it was listed as left alone, not as deleted', async () => {
    const { api } = await cluster([claim(IDLE, { sandbox: 'sb-idle' })], [sandbox('sb-idle')], {
      deleteConflict: true
    })
    const { it: r, infos } = reaper({ api })
    await expect(r.sweep()).resolves.toMatchObject({ idle: 1, deleted: 0, failed: 0 })
    expect(infos.some((m) => m.includes('used since it was listed'))).toBe(true)
  })
})
