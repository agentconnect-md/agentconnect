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
  sandboxSubjectForPath,
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

  it('releases a companion that bound after the session bind had already failed', async () => {
    // The two binds are settled TOGETHER. With the session's rejection propagating on its own, the
    // launch's catch drains its holds while the companion is still binding, and the retain it then
    // takes belongs to no runtime and no `onExit`: the agent pod stays busy until this process
    // restarts, and the idle sweep can never reclaim it.
    const { api } = cluster()
    const pod = podSide()
    const session = sandboxSubjectFor(T1)
    let releaseCompanion: () => void = () => {}
    const companionBound = new Promise<void>((resolve) => (releaseCompanion = resolve))
    const { driver } = member(api, async (record) => {
      // The session's pod refuses at once; the agent's comes up only after that rejection is out.
      if (record.subject === session) throw new Error('session pod refused the channel')
      await companionBound
      return await pod.connect(record)
    })

    const launching = driver.launch(request(T1))
    releaseCompanion()
    await expect(launching).rejects.toThrow(/session pod refused the channel/)

    // The companion bound, so it is held — and released, because the failure that dropped the launch
    // waited for it. Suspending it is the observable form of "nothing still retains this Sandbox".
    expect(driver.currentLaunch(AGENT)).toBeDefined()
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
    // The session's own Sandbox — claimed before its channel refused — is released by the same drain.
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
  })

  it('still degrades rather than failing the launch when only the companion cannot come up', async () => {
    // The companion is a reachability convenience for the agent-scoped seams, never a precondition:
    // settling it beside the session bind must not turn its failure into the session's.
    const { api } = cluster()
    const pod = podSide()
    const { driver } = member(api, async (record) => {
      if (record.subject === AGENT) throw new Error('agent pod refused the channel')
      return await pod.connect(record)
    })

    await expect(driver.launch(request(T1))).resolves.toBeDefined()
    expect(await driver.suspendIfIdle(sandboxSubjectFor(T1))).toBe('busy')
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
  })

  it('reads the pod a path lives on off the PATH, so a suspended pod stays addressable', () => {
    // The launch registry cannot answer this: an idle-suspended session pod is gone from it while its
    // claim and volume survive, and routing off it would send the session's own directory to the agent
    // pod, where it does not exist. Only `<mount>/sessions/<leaf>` names a session pod — nothing else.
    const leaf = hostKeyDirName(T1)
    const at = (path?: string, mount = '/agent'): string => sandboxSubjectForPath(AGENT, path, mount)
    expect(at(`/agent/sessions/${leaf}`)).toBe(sandboxSubjectFor(T1))
    expect(at(`/agent/sessions/${leaf}/workspace/src`)).toBe(sandboxSubjectFor(T1))
    // Everything else is the agent's own pod, including the neighbours a prefix match would swallow.
    expect(at('/agent/checkout')).toBe(AGENT)
    expect(at('/agent/sessions')).toBe(AGENT)
    expect(at('/agent/sessions-other/x')).toBe(AGENT)
    expect(at('/agent/worktrees/abc')).toBe(AGENT)
    expect(at('/agent/.agentconnect/memory')).toBe(AGENT)
    expect(at(undefined)).toBe(AGENT)
    // A leaf that is not a session host's is not a session pod either — a directory, not a subject.
    expect(at(`/agent/sessions/agent/workspace`)).toBe(AGENT)
    // And the mount is the pod's, not a fixed string: a path outside it belongs to no session pod.
    expect(at(`/mnt/vol/sessions/${leaf}/workspace`, '/mnt/vol/')).toBe(sandboxSubjectFor(T1))
    expect(at(`/agent/sessions/${leaf}/workspace`, '/mnt/vol')).toBe(AGENT)
  })

  it('resumes a sleeping session pod onto the claim that was observed, and creates nothing when it is gone', async () => {
    // The observation and the wake are two round trips. Retention, a workspace conversion or an agent
    // removal can delete the claim in between, and `ensureSandbox` would then make a fresh empty one —
    // a console read resurrecting a session sandbox whose row and volume are already retired.
    const { api, claims, modeWrites } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = driver.claimName(session)

    await driver.ensureSandbox(session)
    const claimUid = (await driver.claimUidFor(session))!
    expect(claimUid).toBe(claims.get(name)!.metadata!.uid)
    // The idle sweep: the launch is forgotten, the claim and its volume stay.
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    const claimedSoFar = api.ensureClaim.mock.calls.length

    // The happy path first — a resume is "patch Running, then bind", against the claim just observed.
    await driver.resumeBoundChannel(session, claimUid)
    expect(api.ensureClaim.mock.calls.length).toBe(claimedSoFar)
    expect(modeWrites.at(-1)).toEqual({ sandbox: claims.get(name)!.status!.sandbox!.name, desired: 'Running' })
    expect(driver.currentLaunch(session)?.claimUid).toBe(claimUid)

    // And now retention lands in the gap: the resume refuses instead of claiming a replacement.
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    claims.delete(name)
    await expect(driver.resumeBoundChannel(session, claimUid)).rejects.toThrow(/no longer holds claim/)
    expect(api.ensureClaim.mock.calls.length).toBe(claimedSoFar)
    expect(claims.has(name)).toBe(false)
    expect(driver.currentLaunch(session)).toBeUndefined()
  })

  it('refuses to resume a claim of the same NAME that is a different object', async () => {
    // A leaked claim collected and re-delivered under the deterministic name is a different volume;
    // the name converging is exactly why the fence has to be the object's uid rather than its name.
    const { api, claims } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = driver.claimName(session)

    await driver.ensureSandbox(session)
    const retired = (await driver.claimUidFor(session))!
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    const successor = { ...claims.get(name)!, metadata: { ...claims.get(name)!.metadata, uid: 'claim-successor' } }
    claims.set(name, successor)

    await expect(driver.resumeBoundChannel(session, retired)).rejects.toThrow(/no longer holds claim/)
    expect(claims.get(name)!.metadata!.uid).toBe('claim-successor')
    expect(driver.currentLaunch(session)).toBeUndefined()
  })

  it('retains a pod this member already launched, claiming and waking nothing', async () => {
    // What a console read that may not resurrect a pod holds it with: the idle gate reads `busy`
    // synchronously, so this excludes the sweep instead of checking "is it up" and then awaiting.
    const { api } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    await driver.ensureSandbox(AGENT)

    const release = driver.retainLaunched(session)!
    expect(await driver.suspendIfIdle(session)).toBe('busy')
    // Only that pod: a read of one session's directory must not pin the agent's pod or a sibling's.
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
    release()
    release() // idempotent, so a double release cannot make the pod suspendable under its own holder
    expect(await driver.suspendIfIdle(session)).toBe('suspended')

    // A pod this member holds no launch for retains nothing — and claims nothing to make one.
    const claimedSoFar = api.ensureClaim.mock.calls.length
    expect(driver.retainLaunched(session)).toBeUndefined()
    expect(api.ensureClaim.mock.calls.length).toBe(claimedSoFar)
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
