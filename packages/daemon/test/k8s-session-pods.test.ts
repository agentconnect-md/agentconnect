import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { K8sDriver } from '../src/k8s/driver.js'
import {
  AC_LABEL_AGENT,
  AC_LABEL_ORG,
  AC_LABEL_SESSION,
  sandboxClaimName,
  sandboxSubjectFor,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { fakeGenerations } from './fake-generations.js'
import type { SpawnRecord } from '../src/shim/binding.js'
import type { ShimConnection } from '../src/shim/connection.js'

/**
 * git-workspace-model §11 on the pool: a confined session's host is its own pod. The claim is keyed by
 * the host, labelled by agent AND session, converges across members like the agent's, and dies with
 * the session — while the agent's own pod stays what it was.
 */

const AGENT = 'agent-a'
const T1 = sessionHostKey(AGENT, 'slack:C1:T1:agent-a')
const T2 = sessionHostKey(AGENT, 'slack:C1:T2:agent-a')

/** Whether `labels` satisfy a Kubernetes equality selector (`k=v` or bare `k`, comma-joined). */
function selected(selector: string | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector) return true
  return selector.split(',').every((term) => {
    const [key, value] = term.split('=')
    return value === undefined ? labels?.[key!] !== undefined : labels?.[key!] === value
  })
}

/** A cluster with one Sandbox per claim, so two subjects never share a pod by accident of the fake. */
function cluster() {
  const claims = new Map<string, SandboxClaim>()
  const sandboxes = new Map<string, Sandbox>()
  const modeWrites: Array<{ sandbox: string; desired: string }> = []
  const deleted: string[] = []
  let minted = 0
  const api = {
    ensureClaim: vi.fn(async (claim: SandboxClaim & { metadata: { name: string } }) => {
      const existing = claims.get(claim.metadata.name)
      if (existing) return { claim: existing, created: false }
      const name = `sb-${++minted}`
      sandboxes.set(name, {
        metadata: { name, uid: `uid-${name}` },
        spec: {
          operatingMode: 'Running',
          podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
        },
        status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: [`10.0.0.${minted}`] }
      })
      const stored: SandboxClaim = {
        ...claim,
        metadata: { ...claim.metadata, uid: `claim-${name}` },
        status: { sandbox: { name } }
      }
      claims.set(claim.metadata.name, stored)
      return { claim: stored, created: true }
    }),
    getClaim: async (name: string) => {
      const claim = claims.get(name)
      if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
      return claim
    },
    listClaims: vi.fn(async (selector?: string) =>
      [...claims.values()].filter((claim) => selected(selector, claim.metadata?.labels))
    ),
    deleteClaim: async (name: string) => {
      deleted.push(name)
      const bound = claims.get(name)?.status?.sandbox?.name
      claims.delete(name)
      if (bound) sandboxes.delete(bound)
    },
    getSandbox: async (name: string) => {
      const sandbox = sandboxes.get(name)
      if (!sandbox) throw new K8sApiError(404, 'NotFound', 'no sandbox')
      return sandbox
    },
    getWarmPool: async () => ({ spec: { sandboxTemplateRef: { name: 'runtime-template' } } }),
    getSandboxTemplate: async () => ({
      spec: { podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } } }
    }),
    setOperatingMode: async (name: string, desired: 'Running' | 'Suspended') => {
      modeWrites.push({ sandbox: name, desired })
      const sandbox = sandboxes.get(name)!
      sandboxes.set(name, { ...sandbox, spec: { ...sandbox.spec, operatingMode: desired } })
      return sandboxes.get(name)!
    },
    resumeWithRuntimeImage: async (name: string) => {
      modeWrites.push({ sandbox: name, desired: 'Running' })
      const sandbox = sandboxes.get(name)!
      sandboxes.set(name, { ...sandbox, spec: { ...sandbox.spec, operatingMode: 'Running' } })
      return sandboxes.get(name)!
    },
    reviewToken: vi.fn()
  }
  return { api, claims, sandboxes, modeWrites, deleted }
}

/** A pod side that answers every request and can end its runtime, so the launch's holds are released. */
function podSide() {
  const exits = new Map<string, () => void>()
  const streamId = randomUUID()
  const connect = async (record: SpawnRecord): Promise<ShimConnection> => {
    const listeners: Array<(text: string) => void> = []
    exits.set(record.subject ?? record.agentId, () => {
      const frame = { type: 'shim/event', streamId, event: { kind: 'exit', code: 0, signal: null } }
      for (const listener of listeners) listener(JSON.stringify(frame))
    })
    return {
      binding: { ...record, podName: 'p', podUid: `pod-${record.sandboxUid}` },
      issuedCredential: 'cred',
      send: (frame: { type: string; id: string }) => {
        if (frame.type !== 'shim/request') return
        const reply = { type: 'shim/response', id: frame.id, ok: true, payload: { streamId } }
        for (const listener of listeners) listener(JSON.stringify(reply))
      },
      onFrame: (listener: (text: string) => void) => listeners.push(listener),
      close: () => {}
    } as unknown as ShimConnection
  }
  return { connect, exit: (subject: string) => exits.get(subject)?.() }
}

function member(api: ReturnType<typeof cluster>['api'], connect: ReturnType<typeof podSide>['connect']) {
  const records: SpawnRecord[] = []
  const generations = fakeGenerations()
  const driver = new K8sDriver({
    api: api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations,
    clock: new FakeClock(),
    connectChannel: async (record) => {
      records.push(record)
      return await connect(record)
    },
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
  return { driver, records, generations }
}

const request = (hostKey?: typeof T1) =>
  ({ command: 'x', args: [], env: { AC_AGENT_ID: AGENT }, ...(hostKey ? { hostKey } : {}) }) as never

describe('one sandbox pod per session host (git-workspace-model §11)', () => {
  it('claims a pod per session host, beside the agent pod, labelled by agent AND session leaf', async () => {
    const { api, claims } = cluster()
    const { driver, records } = member(api, podSide().connect)

    await driver.launch(request(T1))
    await driver.launch(request(T2))

    // Three claims: one per session, plus the agent's own, held beside them as the sessions' companion.
    const names = [...claims.keys()].sort()
    expect(new Set(names).size).toBe(3)
    expect(names).toContain(`agent-${AGENT}`)
    for (const key of [T1, T2]) {
      const leaf = hostKeyDirName(key)
      const name = sandboxClaimName(sandboxSubjectFor(key))
      expect(name).toBe(`agent-${AGENT}-${leaf.replace(/^session-/, '').slice(0, 16)}`)
      expect(name.length).toBeLessThanOrEqual(63)
      const claim = claims.get(name)!
      // The session rides its OWN label; the agent label stays the UUID-shaped value the reconciler validates.
      expect(claim.spec?.additionalPodMetadata?.labels).toEqual({
        [AC_LABEL_ORG]: 'org-1',
        [AC_LABEL_AGENT]: AGENT,
        [AC_LABEL_SESSION]: leaf
      })
      expect(claim.metadata?.labels).toEqual(claim.spec?.additionalPodMetadata?.labels)
      // Nothing per-session in the spec beyond the labels, or the claim would bypass warm-pool adoption.
      expect(Object.keys(claim.spec ?? {}).sort()).toEqual(['additionalPodMetadata', 'warmPoolRef'])
    }
    expect(claims.get(`agent-${AGENT}`)!.spec?.additionalPodMetadata?.labels).toEqual({
      [AC_LABEL_ORG]: 'org-1',
      [AC_LABEL_AGENT]: AGENT
    })
    // Each pod was dialled under its own subject (the companion re-binds per launch), with the agent id
    // on the wire for the pod's own checks.
    expect([...new Set(records.map((record) => record.subject))].sort()).toEqual(
      [AGENT, sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort()
    )
    expect(new Set(records.map((record) => record.agentId))).toEqual(new Set([AGENT]))
    expect(new Set(records.map((record) => record.sandboxUid)).size).toBe(3)
    expect(driver.sessionSubjectsOf(AGENT).sort()).toEqual([sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort())
  })

  it('refuses a host key that names another agent than the environment does', async () => {
    const { api } = cluster()
    const { driver } = member(api, podSide().connect)
    await expect(
      driver.launch({ command: 'x', args: [], env: { AC_AGENT_ID: 'agent-b' }, hostKey: T1 } as never)
    ).rejects.toThrow(/names agent agent-a/)
  })

  it('holds the session pod and the agent pod while the session runtime runs, and releases both on exit', async () => {
    const { api, modeWrites, claims } = cluster()
    const pod = podSide()
    const { driver } = member(api, pod.connect)
    const session = sandboxSubjectFor(T1)

    await driver.launch(request(T1))
    expect(await driver.suspendIfIdle(session)).toBe('busy')
    expect(await driver.suspendIfIdle(AGENT)).toBe('busy')

    pod.exit(session)
    await new Promise((resolve) => setImmediate(resolve))
    // Idle now, both — the session's pod suspends on its own, the agent's on its own, claims kept.
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
    expect(modeWrites.map((write) => write.desired)).toEqual(['Suspended', 'Suspended'])
    expect(new Set(modeWrites.map((write) => write.sandbox)).size).toBe(2)
    expect(claims.size).toBe(2)
  })

  it("suspending one session's pod leaves its sibling and the agent pod untouched", async () => {
    const { api, modeWrites } = cluster()
    const pod = podSide()
    const { driver } = member(api, pod.connect)
    await driver.launch(request(T1))
    await driver.launch(request(T2))
    pod.exit(sandboxSubjectFor(T1))
    await new Promise((resolve) => setImmediate(resolve))

    expect(await driver.suspendIfIdle(sandboxSubjectFor(T1))).toBe('suspended')
    // T2's runtime still runs, and it still holds the agent pod as its companion.
    expect(await driver.suspendIfIdle(sandboxSubjectFor(T2))).toBe('busy')
    expect(await driver.suspendIfIdle(AGENT)).toBe('busy')
    expect(modeWrites).toHaveLength(1)
    expect(driver.currentLaunch(sandboxSubjectFor(T2))).toBeDefined()
    expect(driver.currentLaunch(AGENT)).toBeDefined()
  })

  it('converges a second member onto the same session claim after a restart, creating nothing', async () => {
    const { api, claims } = cluster()
    const pod = podSide()
    const first = member(api, pod.connect)
    await first.driver.launch(request(T1))
    const name = sandboxClaimName(sandboxSubjectFor(T1))
    const before = claims.get(name)

    // The successor knows only the host key — the store, not this process, remembers the session.
    const second = member(api, pod.connect)
    const launch = await second.driver.ensureSandbox(sandboxSubjectFor(T1))
    expect(claims.get(name)).toBe(before)
    expect(launch.sandboxName).toBe(before!.status!.sandbox!.name)
    expect(launch.claimUid).toBe(before!.metadata!.uid)
    expect(api.ensureClaim.mock.calls.filter((call) => call[0].metadata.name === name)).toHaveLength(2)
  })

  it('takes over the session pods of an agent by their labels, without knowing their sessions', async () => {
    const { api } = cluster()
    const pod = podSide()
    const first = member(api, pod.connect)
    await first.driver.launch(request(T1))
    await first.driver.launch(request(T2))

    const second = member(api, pod.connect)
    const adopted = await second.driver.adoptSessions(AGENT)
    expect(adopted.sort()).toEqual([sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort())
    expect(
      second.driver
        .launched()
        .map((launch) => launch.subject)
        .sort()
    ).toEqual(adopted.sort())
    expect(api.listClaims).toHaveBeenCalledWith(`${AC_LABEL_AGENT}=${AGENT},${AC_LABEL_SESSION}`)
  })

  it('deletes every pod of a removed agent, the session pods first', async () => {
    const { api, deleted, claims } = cluster()
    const { driver } = member(api, podSide().connect)
    await driver.launch(request(T1))
    await driver.launch(request(T2))

    await driver.removeAgentSandboxes(AGENT)
    expect(claims.size).toBe(0)
    expect(deleted.at(-1)).toBe(`agent-${AGENT}`)
    expect(deleted.slice(0, 2).sort()).toEqual(
      [sandboxClaimName(sandboxSubjectFor(T1)), sandboxClaimName(sandboxSubjectFor(T2))].sort()
    )
    expect(driver.launched()).toEqual([])
  })

  it('retires one session pod alone, and reports whether the cluster still holds a claim', async () => {
    const { api, deleted, claims } = cluster()
    const { driver } = member(api, podSide().connect)
    await driver.launch(request(T1))
    await driver.launch(request(T2))
    const t1 = sandboxSubjectFor(T1)

    expect(await driver.hasClaim(t1)).toBe(true)
    await driver.removeSandbox(t1)
    expect(deleted).toEqual([sandboxClaimName(t1)])
    expect(await driver.hasClaim(t1)).toBe(false)
    expect(claims.has(sandboxClaimName(sandboxSubjectFor(T2)))).toBe(true)
    expect(claims.has(`agent-${AGENT}`)).toBe(true)
    expect(driver.sessionSubjectsOf(AGENT)).toEqual([sandboxSubjectFor(T2)])
  })

  it('keeps the agent pod path byte-identical: no host key means the agent claim, as before', async () => {
    const { api, claims } = cluster()
    const { driver, records } = member(api, podSide().connect)
    await driver.launch(request())
    expect([...claims.keys()]).toEqual([`agent-${AGENT}`])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ agentId: AGENT, subject: AGENT })
    expect(sessionSandboxSubject(AGENT, 'session-abc')).toBe(`${AGENT}/session-abc`)
  })
})
