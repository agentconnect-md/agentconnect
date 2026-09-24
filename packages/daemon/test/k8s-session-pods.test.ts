import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { K8sDriver } from '../src/k8s/driver.js'
import {
  AC_LABEL_AGENT,
  AC_LABEL_ORG,
  AC_LABEL_SESSION,
  AC_ANNOTATION_ADMITTED,
  sandboxClaimName,
  sandboxSubjectFor,
  sandboxSubjectForPath,
  sessionSandboxSubject
} from '../src/k8s/sandbox-identity.js'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import { hostKeyDirName, sessionHostKey } from '../src/acp/host-key.js'
import { fakeGenerations } from './fake-generations.js'
import { fenceFakeSandbox } from './fake-sandbox-fence.js'
import type { SandboxFence } from '../src/k8s/sandbox-api.js'
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
  let versions = 0
  const api = {
    generations: fakeGenerations(),
    fenceSandbox: async (name: string, fence: SandboxFence) => fenceFakeSandbox(sandboxes.get(name)!, fence),
    ensureClaim: vi.fn(async (claim: SandboxClaim & { metadata: { name: string } }) => {
      const existing = claims.get(claim.metadata.name)
      if (existing) {
        // Reuse WRITES: the real client merge-patches the caller's annotations onto the claim it found.
        const merged: SandboxClaim = {
          ...existing,
          metadata: {
            ...existing.metadata,
            annotations: { ...existing.metadata?.annotations, ...claim.metadata.annotations },
            resourceVersion: `rv-${++versions}`
          }
        }
        claims.set(claim.metadata.name, merged)
        return { claim: merged, created: false }
      }
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
        metadata: { ...claim.metadata, uid: `claim-${name}`, resourceVersion: `rv-${++versions}` },
        status: { sandbox: { name } }
      }
      claims.set(claim.metadata.name, stored)
      return { claim: stored, created: true }
    }),
    stampClaim: async (name: string, annotations: Record<string, string>) => {
      const existing = claims.get(name)
      if (!existing) throw new K8sApiError(404, 'NotFound', 'no claim')
      const claim = {
        ...existing,
        metadata: {
          ...existing.metadata,
          annotations: { ...existing.metadata?.annotations, ...annotations },
          resourceVersion: `rv-${++versions}`
        }
      }
      claims.set(name, claim)
      return { claim }
    },
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

function member(
  api: ReturnType<typeof cluster>['api'],
  connect: ReturnType<typeof podSide>['connect'],
  options: { readyTimeoutMs?: number } = {}
) {
  const records: SpawnRecord[] = []
  const warnings: string[] = []
  const generations = api.generations
  const clock = new FakeClock()
  const driver = new K8sDriver({
    api: api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations,
    clock,
    ...options,
    connectChannel: async (record) => {
      records.push(record)
      return await connect(record)
    },
    log: { info: () => {}, warn: (m) => warnings.push(m), debug: () => {} }
  })
  return { driver, records, generations, clock, warnings }
}

const request = (hostKey?: typeof T1) =>
  ({ command: 'x', args: [], env: { AC_AGENT_ID: AGENT }, ...(hostKey ? { hostKey } : {}) }) as never

describe('one sandbox pod per session host (git-workspace-model §11)', () => {
  it('claims a pod per session host and nothing of the agent’s, labelled by agent AND session leaf', async () => {
    const { api, claims } = cluster()
    const { driver, records } = member(api, podSide().connect)

    await driver.launch(request(T1))
    await driver.launch(request(T2))

    // One claim per session: a session runtime holds its own pod alone (#1896).
    const names = [...claims.keys()].sort()
    expect(new Set(names).size).toBe(2)
    expect(names).not.toContain(`agent-${AGENT}`)
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
    // Each pod was dialled under its own subject, with the agent id on the wire for the pod's own checks.
    expect([...new Set(records.map((record) => record.subject))].sort()).toEqual(
      [sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort()
    )
    expect(new Set(records.map((record) => record.agentId))).toEqual(new Set([AGENT]))
    expect(new Set(records.map((record) => record.sandboxUid)).size).toBe(2)
    expect(driver.sessionSubjectsOf(AGENT).sort()).toEqual([sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort())
  })

  it('refuses a host key that names another agent than the environment does', async () => {
    const { api } = cluster()
    const { driver } = member(api, podSide().connect)
    await expect(
      driver.launch({ command: 'x', args: [], env: { AC_AGENT_ID: 'agent-b' }, hostKey: T1 } as never)
    ).rejects.toThrow(/names agent agent-a/)
  })

  it('holds the session pod alone while the session runtime runs, and releases it on exit', async () => {
    const { api, modeWrites, claims } = cluster()
    const pod = podSide()
    const { driver } = member(api, pod.connect)
    const session = sandboxSubjectFor(T1)

    await driver.launch(request(T1))
    expect(await driver.suspendIfIdle(session)).toBe('busy')
    // The agent pod was never launched, so there is nothing of it to hold or suspend.
    expect(await driver.suspendIfIdle(AGENT)).toBe('absent')

    pod.exit(session)
    await new Promise((resolve) => setImmediate(resolve))
    // Idle now: the session's pod suspends, its claim kept.
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    expect(modeWrites.map((write) => write.desired)).toEqual(['Suspended'])
    expect(claims.size).toBe(1)
  })

  it("suspending one session's pod leaves its sibling and the agent pod untouched", async () => {
    const { api, modeWrites } = cluster()
    const pod = podSide()
    const { driver } = member(api, pod.connect)
    await driver.launch(request())
    await driver.launch(request(T1))
    await driver.launch(request(T2))
    pod.exit(sandboxSubjectFor(T1))
    await new Promise((resolve) => setImmediate(resolve))

    expect(await driver.suspendIfIdle(sandboxSubjectFor(T1))).toBe('suspended')
    // T2's runtime still holds its own pod; the agent's runtime, the agent's.
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
    // The same claim object, restamped rather than replaced: same uid, same bound Sandbox, no create.
    expect(claims.get(name)?.metadata?.uid).toBe(before!.metadata!.uid)
    expect(claims.get(name)?.status?.sandbox?.name).toBe(before!.status!.sandbox!.name)
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

  it('starts a new takeover after departure without reusing the old ownership promise', async () => {
    const { api } = cluster()
    const subject = sandboxSubjectFor(T1)
    await member(api, podSide().connect).driver.ensureSandbox(subject)
    const { driver } = member(api, podSide().connect)
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => (unblock = resolve))
    const read = api.getClaim
    vi.spyOn(api, 'getClaim').mockImplementationOnce(async (name) => {
      await blocked
      return read(name)
    })
    const oldAttempt = driver.adopt(subject)
    driver.releaseAgentSandboxes(AGENT)
    const newAttempt = driver.adopt(subject)
    const launch = await newAttempt
    expect(newAttempt).not.toBe(oldAttempt)
    expect(launch).toBeDefined()
    unblock()
    await oldAttempt
    expect(driver.currentLaunch(subject)).toBe(launch)
  })

  it.each(['ensure', 'resume'] as const)('refuses %s queued behind a takeover when the agent departs', async (kind) => {
    const { api } = cluster()
    const subject = sandboxSubjectFor(T1)
    const launch = await member(api, podSide().connect).driver.ensureSandbox(subject)
    const { driver, records } = member(api, podSide().connect)
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => (unblock = resolve))
    const read = api.getClaim
    vi.spyOn(api, 'getClaim').mockImplementationOnce(async (name) => {
      await blocked
      return read(name)
    })
    const takeover = driver.adopt(subject)
    const acquisition =
      kind === 'ensure' ? driver.ensureBoundChannel(subject) : driver.resumeBoundChannel(subject, launch.claimUid)
    const refused = expect(acquisition).rejects.toThrow('left this member')
    driver.releaseAgentSandboxes(AGENT)
    unblock()
    await takeover
    await refused
    expect(driver.launched()).toEqual([])
    expect(records).toEqual([])
  })

  it('reports partial takeover failure and adopts the remaining session on retry', async () => {
    const { api } = cluster()
    const first = member(api, podSide().connect)
    await first.driver.ensureSandbox(sandboxSubjectFor(T1))
    await first.driver.ensureSandbox(sandboxSubjectFor(T2))
    const stamp = api.stampClaim
    api.stampClaim = vi.fn(stamp).mockRejectedValueOnce(new Error('claim stamp unavailable'))
    const second = member(api, podSide().connect)

    await expect(second.driver.adoptSessions(AGENT)).rejects.toThrow('could not adopt 1 session sandbox')
    expect(second.driver.sessionSubjectsOf(AGENT)).toEqual([sandboxSubjectFor(T2)])
    expect((await second.driver.adoptSessions(AGENT)).sort()).toEqual(
      [sandboxSubjectFor(T1), sandboxSubjectFor(T2)].sort()
    )
  })

  it.each(['listing', 'stamping'] as const)('does not publish a session takeover released during %s', async (stage) => {
    const { api } = cluster()
    const session = sandboxSubjectFor(T1)
    const first = member(api, podSide().connect)
    await first.driver.ensureSandbox(session)
    const second = member(api, podSide().connect)
    let finish!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => (finish = resolve))
    const waiting = new Promise<void>((resolve) => (entered = resolve))
    const pause = async () => {
      entered()
      await blocked
    }
    if (stage === 'listing') {
      const list = api.listClaims
      api.listClaims = vi.fn(async (selector?: string) => {
        await pause()
        return await list(selector)
      })
    } else {
      const stamp = api.stampClaim
      api.stampClaim = async (name, annotations) => {
        await pause()
        return await stamp(name, annotations)
      }
    }
    const adopting = second.driver.adoptSessions(AGENT).catch(() => [])
    await waiting
    // No session launch exists yet for releaseAgent to enumerate, so the agent fence must cover it.
    second.driver.release(AGENT)
    finish()
    await adopting
    expect(second.driver.launched()).toEqual([])
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
    expect(driver.sessionSubjectsOf(AGENT)).toEqual([sandboxSubjectFor(T2)])
  })

  it('releases a session pod whose bind failed, and puts it back to sleep', async () => {
    const { api, claims, modeWrites } = cluster()
    const session = sandboxSubjectFor(T1)
    const { driver } = member(api, async () => {
      throw new Error('session pod refused the channel')
    })

    await expect(driver.launch(request(T1))).rejects.toThrow(/session pod refused the channel/)

    // Claimed before its channel refused, released by the launch's failure, and nothing uses a pod whose bind failed.
    await vi.waitFor(() => expect(driver.currentLaunch(session)).toBeUndefined())
    const sessionSandbox = claims.get(driver.claimName(session))!.status!.sandbox!.name
    expect(modeWrites).toContainEqual({ sandbox: sessionSandbox, desired: 'Suspended' })
    expect(claims.has(`agent-${AGENT}`)).toBe(false)
  })

  it('forgets a missing sandbox during an idle suspend without deleting its claim', async () => {
    const { api, claims, sandboxes } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const launch = await driver.ensureSandbox(session)
    sandboxes.delete(launch.sandboxName)

    expect(await driver.suspendIfIdle(session)).toBe('absent')
    expect(driver.currentLaunch(session)).toBeUndefined()
    expect(await driver.suspendIfIdle(session)).toBe('absent')
    expect(claims.has(sandboxClaimName(session))).toBe(true)
  })

  it('rechecks the claim and dispatches into its replacement after a cached sandbox returns 404', async () => {
    const { api, claims, sandboxes } = cluster()
    const pod = podSide()
    const { driver, records } = member(api, pod.connect)
    const session = sandboxSubjectFor(T1)
    await driver.launch(request(T1))
    pod.exit(session)
    await new Promise((resolve) => setImmediate(resolve))
    const previous = driver.currentLaunch(session)!
    const replacementName = 'sb-replacement'
    const replacementUid = 'uid-replacement'
    const priorSandbox = sandboxes.get(previous.sandboxName)!
    sandboxes.delete(previous.sandboxName)
    sandboxes.set(replacementName, {
      ...priorSandbox,
      metadata: { ...priorSandbox.metadata, name: replacementName, uid: replacementUid }
    })
    const claimName = sandboxClaimName(session)
    const claim = claims.get(claimName)!
    claims.set(claimName, { ...claim, status: { sandbox: { name: replacementName } } })

    await driver.withSandbox(session, async () => {
      await driver.ensureBoundChannel(session)
      expect(await driver.suspendIfIdle(session)).toBe('busy')
    })
    await driver.launch(request(T1))

    expect(driver.currentLaunch(session)?.sandboxName).toBe(replacementName)
    expect(driver.currentLaunch(session)?.sandboxUid).toBe(replacementUid)
    expect(driver.currentLaunch(session)?.claimUid).toBe(previous.claimUid)
    expect(records.at(-1)?.sandboxUid).toBe(replacementUid)
    expect(api.ensureClaim).toHaveBeenCalledTimes(2)
  })

  it('does not reacquire a missing sandbox after the agent leaves during cache validation', async () => {
    const { api } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    let finishRead!: () => void
    const blocked = new Promise<void>((resolve) => (finishRead = resolve))
    api.getSandbox = async () => {
      await blocked
      throw new K8sApiError(404, 'NotFound', 'no sandbox')
    }

    const acquiring = driver.ensureSandbox(session)
    driver.release(session)
    finishRead()

    await expect(acquiring).rejects.toThrow(/left this member/)
    expect(driver.currentLaunch(session)).toBeUndefined()
    expect(api.ensureClaim).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a missing warm pool for a missing sandbox', async () => {
    const { api, sandboxes } = cluster()
    const { driver } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureBoundChannel(session)
    const launch = driver.currentLaunch(session)!
    const sandbox = sandboxes.get(launch.sandboxName)!
    sandboxes.set(launch.sandboxName, { ...sandbox, spec: { ...sandbox.spec, operatingMode: 'Suspended' } })
    api.getWarmPool = async () => {
      throw new K8sApiError(404, 'NotFound', 'no warm pool')
    }

    await expect(driver.ensureBoundChannel(session)).rejects.toThrow('no warm pool')

    expect(driver.currentLaunch(session)).toBe(launch)
    expect(driver.sessionFor(session)?.isAttached()).toBe(true)
  })

  it('puts a resumed session pod that never comes up back to sleep, so it cannot keep its node full', async () => {
    // Left Running, a pod the scheduler cannot place keeps its CPU request, and every later wake on that node fails the same way.
    const { api, claims, sandboxes, modeWrites } = cluster()
    const { driver } = member(api, podSide().connect, { readyTimeoutMs: 0 })
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    const claimUid = (await driver.claimUidFor(session))!
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    const name = claims.get(driver.claimName(session))!.status!.sandbox!.name!
    sandboxes.set(name, { ...sandboxes.get(name)!, status: { conditions: [{ type: 'Ready', status: 'False' }] } })

    await expect(driver.resumeBoundChannel(session, claimUid)).rejects.toThrow(/did not become ready in time/)
    await vi.waitFor(() => expect(driver.currentLaunch(session)).toBeUndefined())
    expect(modeWrites.filter((write) => write.sandbox === name).map((write) => write.desired)).toEqual([
      'Suspended',
      'Running',
      'Suspended'
    ])
    // Claim and volume stay: the next read or message resumes onto them.
    expect(claims.get(driver.claimName(session))!.metadata!.uid).toBe(claimUid)
  })

  it('leaves a pod alone when a re-dial fails while an earlier channel to it is still attached', async () => {
    const { api, modeWrites } = cluster()
    const pod = podSide()
    let refuse = false
    const { driver } = member(api, async (record) => {
      if (refuse) throw new Error('shim refused the re-dial')
      return await pod.connect(record)
    })
    await driver.ensureBoundChannel(AGENT)
    refuse = true

    await expect(driver.ensureBoundChannel(AGENT)).rejects.toThrow(/refused the re-dial/)
    // Still launched and nothing in flight: the pod serves the channel that is attached.
    expect(modeWrites).toEqual([])
    expect(await driver.suspendIfIdle(AGENT)).toBe('suspended')
  })

  it('suspends a launched pod still not up a full pod-up bound later and never bound, and nothing else', async () => {
    const { api, claims, sandboxes, modeWrites } = cluster()
    const { driver, clock } = member(api, podSide().connect)
    const stuck = sandboxSubjectFor(T1)
    const bound = sandboxSubjectFor(T2)
    await driver.ensureBoundChannel(bound)
    await driver.ensureSandbox(stuck)
    const sandboxOf = (subject: string): string => claims.get(driver.claimName(subject))!.status!.sandbox!.name!
    const readiness = (subject: string, status: 'True' | 'False'): void => {
      const name = sandboxOf(subject)
      const sandbox = sandboxes.get(name)!
      sandboxes.set(name, { ...sandbox, status: { ...sandbox.status, conditions: [{ type: 'Ready', status }] } })
    }
    readiness(stuck, 'False')
    readiness(bound, 'False')

    // Inside the bound it may still be coming up.
    expect(await driver.suspendIfStalled(stuck)).toBe('absent')
    clock.advance(driver.podUpTimeoutMs)
    // One this member ever bound is judged as bound, whatever its pod does next; a subject with no launch has nothing to suspend.
    expect(await driver.suspendIfStalled(bound)).toBe('absent')
    expect(await driver.suspendIfStalled(AGENT)).toBe('absent')
    // A pod that is up is idle, not stalled, and is left to the activity window.
    readiness(stuck, 'True')
    expect(await driver.suspendIfStalled(stuck)).toBe('absent')
    expect(modeWrites).toEqual([])

    readiness(stuck, 'False')
    expect(await driver.suspendIfStalled(stuck)).toBe('suspended')
    expect(driver.currentLaunch(stuck)).toBeUndefined()
    expect(modeWrites).toEqual([{ sandbox: sandboxOf(stuck), desired: 'Suspended' }])
  })

  it('lets a bind that lands during the readiness read win over a stalled suspension', async () => {
    // The read can outlive what justified it: the pod comes up and a console wake binds it before the stale `starting` answer returns.
    const { api, claims, sandboxes, modeWrites } = cluster()
    const { driver, clock } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    const name = claims.get(driver.claimName(session))!.status!.sandbox!.name!
    const ready = sandboxes.get(name)!
    sandboxes.set(name, { ...ready, status: { conditions: [{ type: 'Ready', status: 'False' }] } })
    clock.advance(driver.podUpTimeoutMs)
    const read = api.getSandbox
    let answer: () => void = () => {}
    const answered = new Promise<void>((resolve) => (answer = resolve))
    api.getSandbox = async (sandboxName: string) => {
      api.getSandbox = read
      const snapshot = await read(sandboxName)
      await answered
      return snapshot
    }

    const suspending = driver.suspendIfStalled(session)
    sandboxes.set(name, ready)
    await driver.ensureBoundChannel(session)
    answer()

    expect(await suspending).toBe('absent')
    expect(modeWrites).toEqual([])
    expect(driver.sessionFor(session)?.isAttached()).toBe(true)
  })

  it('launches a session runtime while the agent pod refuses every call, never asking it anything', async () => {
    // A session runtime needs its own pod only (#1896): the agent's is neither claimed nor dialled for it.
    const { api, claims } = cluster()
    const pod = podSide()
    const ensureClaim = api.ensureClaim.getMockImplementation()!
    api.ensureClaim.mockImplementation(async (claim) => {
      if (claim.metadata.name === `agent-${AGENT}`) throw new Error('the agent pod refuses every call')
      return await ensureClaim(claim)
    })
    const { driver, records } = member(api, async (record) => {
      if (record.subject === AGENT) throw new Error('the agent pod refuses every call')
      return await pod.connect(record)
    })

    await expect(driver.launch(request(T1))).resolves.toBeDefined()
    expect(await driver.suspendIfIdle(sandboxSubjectFor(T1))).toBe('busy')
    expect(api.ensureClaim.mock.calls.map((call) => call[0].metadata.name)).toEqual([
      sandboxClaimName(sandboxSubjectFor(T1))
    ])
    expect(records.map((record) => record.subject)).toEqual([sandboxSubjectFor(T1)])
    expect(driver.currentLaunch(AGENT)).toBeUndefined()
    expect(claims.has(`agent-${AGENT}`)).toBe(false)
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

  it('refuses to retain a pod whose suspension is already in flight', async () => {
    // Its channel is still attached until the write lands, so only the gate says the pod is going: an arm held across it would start a watcher the write then kills.
    const { api } = cluster()
    const { driver } = member(api, podSide().connect)
    await driver.ensureBoundChannel(AGENT)

    const suspending = driver.suspendIfIdle(AGENT)
    expect(driver.sessionFor(AGENT)?.isAttached()).toBe(true)
    expect(driver.retainLaunched(AGENT)).toBeUndefined()
    expect(await suspending).toBe('suspended')
  })

  it('binds a pod it already launched but never bound — a takeover — claiming and waking nothing', async () => {
    // A successor records a Running pod with no channel, and asking its watcher registry needs one.
    const { api, modeWrites } = cluster()
    const first = member(api, podSide().connect)
    await first.driver.ensureBoundChannel(AGENT)
    const successor = member(api, podSide().connect)
    expect(await successor.driver.adopt(AGENT)).toBeDefined()
    expect(successor.driver.sessionFor(AGENT)).toBeUndefined()
    const claimed = api.ensureClaim.mock.calls.length

    expect((await successor.driver.bindLaunched(AGENT))?.isAttached()).toBe(true)
    expect(successor.records.map((record) => record.subject)).toEqual([AGENT])
    expect(api.ensureClaim.mock.calls.length).toBe(claimed)
    expect(modeWrites).toEqual([])
    // Already bound: the same session, no second dial.
    await successor.driver.bindLaunched(AGENT)
    expect(successor.records).toHaveLength(1)
  })

  it('binds nothing it holds no launch for, and no pod that is not up', async () => {
    const { api, claims, sandboxes, modeWrites } = cluster()
    const { driver, records } = member(api, podSide().connect)
    expect(await driver.bindLaunched(AGENT)).toBeUndefined()
    expect(claims.size).toBe(0)

    // Launched, but its Sandbox is not Running: a bind would resume it, which is a wake, not a question.
    await driver.ensureSandbox(AGENT)
    const name = claims.get(driver.claimName(AGENT))!.status!.sandbox!.name!
    const sandbox = sandboxes.get(name)!
    sandboxes.set(name, { ...sandbox, spec: { ...sandbox.spec, operatingMode: 'Suspended' } })
    expect(await driver.bindLaunched(AGENT)).toBeUndefined()
    expect(records).toEqual([])
    expect(modeWrites).toEqual([])
  })

  it('stamps every admission on the claim, so a reused one is a new incarnation to a reader', async () => {
    // The orphan sweep proves a session gone from a snapshot and then deletes on the version it
    // listed. A session that comes back reuses this claim rather than making one, so without a write
    // here the sweep's preconditions would still hold and it would take a live pod and its volume.
    const { api, claims } = cluster()
    const { driver, clock } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = sandboxClaimName(session)

    await driver.ensureSandbox(session)
    const first = claims.get(name)!
    expect(first.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(new Date(clock.now()).toISOString())
    // Never in the spec or on the pod: warm-pool adoption reads the spec, and this is not the pod's business.
    expect(Object.keys(first.spec ?? {}).sort()).toEqual(['additionalPodMetadata', 'warmPoolRef'])
    expect(first.spec?.additionalPodMetadata?.labels?.[AC_ANNOTATION_ADMITTED]).toBeUndefined()

    // A second admission of the SAME claim — a resume after an idle suspension — restamps and re-versions it.
    driver.release(session)
    clock.advance(60_000)
    await driver.ensureSandbox(session)
    const second = claims.get(name)!
    expect(second.metadata?.uid).toBe(first.metadata?.uid)
    expect(second.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(new Date(clock.now()).toISOString())
    expect(second.metadata?.resourceVersion).not.toBe(first.metadata?.resourceVersion)
  })

  it('still admits — and launches — when the API server refuses the stamp, saying so once', async () => {
    // A Role without `patch` on claims costs the orphan sweep its fence, and nothing else. Failing the
    // admission instead would turn a permission gap into an outage on every resume of an existing
    // claim, which is strictly worse than the race the stamp closes.
    const { api, claims } = cluster()
    const admit = api.ensureClaim
    api.ensureClaim = vi.fn(async (claim: SandboxClaim & { metadata: { name: string } }) => {
      const ensured = await admit(claim)
      // The refusal writes nothing, so the claim keeps the annotations and version it already had.
      return ensured.created ? ensured : { ...ensured, stampRefused: true }
    }) as never
    const { driver, warnings } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)

    await driver.ensureSandbox(session)
    driver.release(session)
    await expect(driver.ensureSandbox(session)).resolves.toBeDefined()
    driver.release(session)
    await driver.ensureSandbox(session)

    // The pod is claimed and usable throughout; only the fence is gone.
    expect(claims.has(sandboxClaimName(session))).toBe(true)
    expect(driver.currentLaunch(session)).toBeDefined()
    // Once per process, not once per admission: a degraded Role would otherwise fill the log.
    expect(warnings.filter((line) => line.includes('refused the admission stamp'))).toHaveLength(1)
    expect(warnings[0]).toMatch(/patch on sandboxclaims/)
  })

  it('refreshes the stamp on every claim it HOLDS, so one in use never reads as a leak', async () => {
    // `ensureSandbox` returns from the launch registry without touching the API, and `adoptSessions`
    // caches a Running claim this member never admitted — so a member can serve a session for hours
    // without writing to its claim. A sweep that snapshotted the row as absent would then still match
    // on resourceVersion when the row came back, and take a live pod's volume.
    const { api, claims } = cluster()
    const { driver, clock } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    await driver.ensureSandbox(AGENT)
    const before = [...claims.values()].map((claim) => claim.metadata?.resourceVersion)

    clock.advance(180_000)
    await driver.refreshAdmissionStamps()

    // Every held claim is young again, and its version moved — both halves of the fence, without an admission.
    for (const claim of claims.values()) {
      expect(claim.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(new Date(clock.now()).toISOString())
    }
    expect([...claims.values()].map((claim) => claim.metadata?.resourceVersion)).not.toEqual(before)
    // A pod this member no longer holds is nobody's to keep alive: releasing it stops the refresh.
    driver.release(session)
    clock.advance(180_000)
    await driver.refreshAdmissionStamps()
    expect(claims.get(sandboxClaimName(session))!.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).not.toBe(
      new Date(clock.now()).toISOString()
    )
    expect(claims.get(`agent-${AGENT}`)!.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(
      new Date(clock.now()).toISOString()
    )
  })

  it('keeps refreshing the rest when one claim is gone or its stamp is refused', async () => {
    // Best effort by construction: this runs on a tick, off every turn's path, so one claim's failure
    // must not cost the others their freshness — and a Role without `patch` says so once, as admission does.
    const { api, claims } = cluster()
    const { driver, clock, warnings } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    await driver.ensureSandbox(AGENT)
    // The session's claim is retired underneath the member; the agent's refuses the write.
    claims.delete(sandboxClaimName(session))
    const stamp = api.stampClaim
    api.stampClaim = (async (name: string, annotations: Record<string, string>) => {
      const stamped = await stamp(name, annotations)
      return { claim: stamped.claim, stampRefused: true }
    }) as never

    clock.advance(180_000)
    await expect(driver.refreshAdmissionStamps()).resolves.toBeUndefined()
    await driver.refreshAdmissionStamps()

    expect(claims.get(`agent-${AGENT}`)!.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBeDefined()
    expect(warnings.filter((line) => line.includes('refused the admission stamp'))).toHaveLength(1)
  })

  it('stamps a takeover BEFORE it publishes the launch, not at the next tick', async () => {
    // `setInterval` does not fire for a whole period, and a takeover writes nothing to the claim on its
    // own — so in that first window an adopted claim looks untouched while a returning delivery is
    // already being served from the registry. A sweep holding this claim's old version would still
    // match, and delete a live pod.
    const { api, claims } = cluster()
    const first = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = sandboxClaimName(session)
    await first.driver.ensureSandbox(session)
    const admitted = claims.get(name)!.metadata!.resourceVersion

    // A second member takes it over, with no timer having run anywhere.
    const successor = member(api, podSide().connect)
    successor.clock.advance(600_000)
    expect(await successor.driver.adopt(session)).toBeDefined()

    const taken = claims.get(name)!
    expect(taken.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(new Date(successor.clock.now()).toISOString())
    // The version moved with it, so a delete preconditioned on what the sweep listed no longer matches.
    expect(taken.metadata?.resourceVersion).not.toBe(admitted)
  })

  it('stamps a resume onto an observed claim, which publishes a launch without admitting one either', async () => {
    // The same class as a takeover, and the reviewer named only the takeover: `resumeSandbox` records a
    // launch straight from the claim it read, so it too would serve a session off an untouched claim.
    const { api, claims } = cluster()
    const { driver, clock } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = sandboxClaimName(session)
    await driver.ensureSandbox(session)
    const claimUid = (await driver.claimUidFor(session))!
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    const before = claims.get(name)!.metadata!.resourceVersion

    clock.advance(600_000)
    await driver.resumeBoundChannel(session, claimUid)

    const resumed = claims.get(name)!
    expect(resumed.metadata?.annotations?.[AC_ANNOTATION_ADMITTED]).toBe(new Date(clock.now()).toISOString())
    expect(resumed.metadata?.resourceVersion).not.toBe(before)
    // Still a resume, not an admission: the claim is the same object, never a replacement.
    expect(resumed.metadata?.uid).toBe(claimUid)
  })

  it('publishes no launch when the fence write fails for any reason but permission', async () => {
    // The fence is what a published launch RESTS on, so swallowing a timeout or a 500 here would be the
    // same as never stamping: the sweep still holds the version it listed, and its delete still takes a
    // live volume. A takeover that cannot fence adopts nothing; a resume refuses the read.
    const { api, claims } = cluster()
    const { driver, clock, warnings } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    const name = sandboxClaimName(session)
    await driver.ensureSandbox(session)
    const claimUid = (await driver.claimUidFor(session))!
    expect(await driver.suspendIfIdle(session)).toBe('suspended')
    const fenced = claims.get(name)!.metadata!.resourceVersion

    api.stampClaim = (async () => {
      throw new Error('the API server is having a moment')
    }) as never
    clock.advance(600_000)

    // A resume refuses rather than serving a pod the sweep could collect underneath it.
    await expect(driver.resumeBoundChannel(session, claimUid)).rejects.toThrow(/could not be marked in use/)
    expect(driver.currentLaunch(session)).toBeUndefined()
    // And a takeover adopts nothing, leaving the next duty tick to try again.
    expect(await driver.adopt(session)).toBeUndefined()
    expect(driver.currentLaunch(session)).toBeUndefined()
    // Nothing was written, so the claim the sweep listed is untouched — and it says why, out loud.
    expect(claims.get(name)!.metadata?.resourceVersion).toBe(fenced)
    expect(warnings.some((line) => line.includes('could not be marked in use'))).toBe(true)
  })

  it('still publishes when the fence is refused by permission alone, reporting it once', async () => {
    // The legacy-Role degradation stays exactly as agreed: failing every takeover over a missing verb
    // would be worse than the race, and it is already reported once per process.
    const { api } = cluster()
    const { driver, warnings } = member(api, podSide().connect)
    const session = sandboxSubjectFor(T1)
    await driver.ensureSandbox(session)
    const claimUid = (await driver.claimUidFor(session))!
    expect(await driver.suspendIfIdle(session)).toBe('suspended')

    const stamp = api.stampClaim
    api.stampClaim = (async (name: string, annotations: Record<string, string>) => {
      const stamped = await stamp(name, annotations)
      return { claim: stamped.claim, stampRefused: true }
    }) as never

    await driver.resumeBoundChannel(session, claimUid)
    expect(driver.currentLaunch(session)).toBeDefined()
    expect(warnings.filter((line) => line.includes('refused the admission stamp'))).toHaveLength(1)
    expect(warnings.some((line) => line.includes('could not be marked in use'))).toBe(false)
  })

  it('keeps the agent pod path byte-identical: no host key means the agent claim, as before', async () => {
    const { api, claims } = cluster()
    const { driver, records } = member(api, podSide().connect)
    await driver.launch(request())
    expect([...claims.keys()]).toEqual([`agent-${AGENT}`])
    expect(claims.get(`agent-${AGENT}`)!.spec?.additionalPodMetadata?.labels).toEqual({
      [AC_LABEL_ORG]: 'org-1',
      [AC_LABEL_AGENT]: AGENT
    })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ agentId: AGENT, subject: AGENT })
    expect(sessionSandboxSubject(AGENT, 'session-abc')).toBe(`${AGENT}/session-abc`)
  })
})
