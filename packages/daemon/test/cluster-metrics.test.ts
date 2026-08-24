import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sDriver, type K8sDriverDeps } from '../src/k8s/driver.js'
import { LaunchTimer, type ClusterMetrics, type LaunchPath, type LaunchStage } from '../src/metrics/cluster-metrics.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { GuardedResumeRejectedError, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'
import { fakeGenerations } from './fake-generations.js'

type AwaitChannel = (
  agentId: string,
  generation: number,
  timeoutMs: number
) => ReturnType<K8sDriverDeps['connectChannel']>

// The acceptance criterion for D9 is a dashboard that settles "resume p95 ≤ 15s, cold start
// p95 ≤ 60s" without log archaeology. That is only true if the cold/resume tag is right and the
// stages actually fire, so this asserts the recorded series rather than that the code runs.

function recorder(): {
  metrics: ClusterMetrics
  stages: Array<{ stage: LaunchStage; path: LaunchPath; durationMs: number }>
  launches: Array<{ path: string; outcome: string; durationMs: number }>
  rejections: string[]
  channels: string[]
  retries: string[]
  relists: string[]
  tokenReviews: number
  drains: number
} {
  const state = {
    stages: [] as Array<{ stage: LaunchStage; path: LaunchPath; durationMs: number }>,
    launches: [] as Array<{ path: string; outcome: string; durationMs: number }>,
    rejections: [] as string[],
    channels: [] as string[],
    retries: [] as string[],
    relists: [] as string[],
    tokenReviews: 0,
    drains: 0
  }
  const metrics: ClusterMetrics = {
    stage: (stage, path, durationMs) => state.stages.push({ stage, path, durationMs }),
    launch: (path, outcome, durationMs) => state.launches.push({ path, outcome, durationMs }),
    handshakeRejected: (reason) => state.rejections.push(reason),
    tokenReviewRejected: () => (state.tokenReviews += 1),
    writeRetry: (kind) => state.retries.push(kind),
    watchRelist: (source) => state.relists.push(source),
    channel: (event) => state.channels.push(event),
    drainTimeout: () => (state.drains += 1)
  }
  return { metrics, ...state }
}

/** A cluster whose claim either already exists (resume/warm) or is created (cold). */
function fakeApi(options: { claimExists: boolean; mode: 'Running' | 'Suspended' }) {
  const state = {
    mode: options.mode,
    claim: options.claimExists
      ? ({ metadata: { name: 'agent-a' }, status: { sandbox: { name: 'sb-1' } } } as SandboxClaim)
      : undefined
  }
  return {
    state,
    api: {
      ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
        const created = state.claim === undefined
        state.claim = { ...claim, status: { sandbox: { name: 'sb-1' } } }
        return { claim: state.claim, created }
      },
      getClaim: async () => {
        if (!state.claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return state.claim
      },
      deleteClaim: async () => undefined,
      getSandbox: async () =>
        ({
          metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
          spec: {
            operatingMode: state.mode,
            podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
          },
          status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['10.0.0.8'] }
        }) as Sandbox,
      getWarmPool: async () => ({ spec: { sandboxTemplateRef: { name: 'runtime-template' } } }),
      getSandboxTemplate: async () => ({
        spec: { podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } } }
      }),
      resumeWithRuntimeImage: async (
        _name: string,
        image: { containerIndex: number; observedName: string; observedImage: string; targetImage: string }
      ) => {
        if (
          state.mode !== 'Suspended' ||
          image.containerIndex !== 0 ||
          image.observedName !== 'runtime' ||
          image.observedImage !== 'runtime:1'
        ) {
          throw new GuardedResumeRejectedError('sb-1', new K8sApiError(422, 'Invalid', 'guard rejected'))
        }
        state.mode = 'Running'
        return {} as Sandbox
      },
      setOperatingMode: async (_name: string, desired: 'Running' | 'Suspended') => {
        state.mode = desired
        return {} as Sandbox
      },
      watchClaims: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

/**
 * A connection that ANSWERS the ACP open, because the runtime-ready stage closes when the open
 * resolves — not when `launch()` returns. A silent fake made that stage measure the cost of
 * constructing a stream pair, which is how a runtime that never started looked like a success.
 */
function respondingConnection(outcome: 'ok' | 'error' | 'timeout') {
  const listeners: Array<(text: string) => void> = []
  return {
    binding: { agentId: 'agent-a', generation: 1, grants: ['acp'], podName: 'p', podUid: 'u' },
    issuedCredential: 'cred',
    send: (frame: { type: string; id: string }) => {
      if (frame.type !== 'shim/request') return
      // A timeout is modelled by never answering, which is what a wedged runtime actually does.
      // Answering with an error would exercise the failure path instead.
      if (outcome === 'timeout') return
      const reply =
        outcome === 'ok'
          ? { type: 'shim/response', id: frame.id, ok: true, payload: { streamId: randomUUID() } }
          : { type: 'shim/response', id: frame.id, ok: false, error: 'runtime exited immediately' }
      setTimeout(() => {
        for (const listen of listeners) listen(JSON.stringify(reply))
      }, 0)
    },
    onFrame: (listen: (text: string) => void) => listeners.push(listen),
    close: () => {}
  }
}

/** The shim's replacement socket for an agent, as the listener reports it. */
function rebind(generation = 1) {
  return {
    binding: { agentId: 'agent-a', generation, grants: ['acp'], podName: 'p', podUid: 'u' },
    issuedCredential: 'cred-2',
    send: () => {},
    onFrame: () => {},
    close: () => {}
  } as never
}

function driverFor(
  metrics: ClusterMetrics,
  api: ReturnType<typeof fakeApi>,
  open: 'ok' | 'error' | 'timeout' = 'ok',
  clock: FakeClock = new FakeClock(),
  awaitChannel?: AwaitChannel
) {
  return new K8sDriver({
    api: api.api as never,
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    connectChannel: awaitChannel
      ? async (record, _podIp, timeoutMs) => await awaitChannel(record.agentId, record.generation, timeoutMs)
      : async () => respondingConnection(open) as never,
    clock,
    metrics,
    readyTimeoutMs: 5_000,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
}

/**
 * Launch while driving the fake clock forward.
 *
 * The claim-bind and pod-ready waits sleep on the driver's clock, so a FakeClock that nobody
 * advances makes their deadline unreachable — the test would hang rather than observe a timeout.
 */
async function launchAdvancing(driver: K8sDriver, clock: FakeClock): Promise<Error | 'resolved'> {
  let outcome: Error | 'resolved' | undefined
  const inflight = driver.launch(launchRequest).then(
    () => {
      outcome = 'resolved'
    },
    (err: Error) => {
      outcome = err
    }
  )
  for (let step = 0; step < 400 && outcome === undefined; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    clock.advance(1_000)
  }
  await inflight
  return outcome ?? new Error('launch never settled')
}

async function settled(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

const launchRequest = { command: 'x', args: [], env: { AC_AGENT_ID: 'agent-a' }, cwd: '/agent' } as never

describe('cluster launch metrics', () => {
  it('tags a first launch COLD and a re-launch of a suspended sandbox RESUME', async () => {
    // These are the two targets, and they are different paths: a first claim pays PVC
    // provisioning and an image pull, a resume pays a re-attach. One distribution over both
    // could not settle either number.
    const cold = recorder()
    await driverFor(cold.metrics, fakeApi({ claimExists: false, mode: 'Suspended' })).launch(launchRequest)
    expect(await settled(() => cold.launches.length > 0)).toBe(true)
    expect(new Set(cold.stages.map((entry) => entry.path))).toEqual(new Set(['cold']))
    expect(cold.launches).toEqual([expect.objectContaining({ path: 'cold', outcome: 'ok' })])

    const resume = recorder()
    await driverFor(resume.metrics, fakeApi({ claimExists: true, mode: 'Suspended' })).launch(launchRequest)
    expect(await settled(() => resume.launches.length > 0)).toBe(true)
    expect(new Set(resume.stages.map((entry) => entry.path))).toEqual(new Set(['resume']))
    expect(resume.launches).toEqual([expect.objectContaining({ path: 'resume', outcome: 'ok' })])

    // A sandbox already Running is neither: counting it as a resume would drag the resume
    // distribution down with launches that paid nothing.
    const warm = recorder()
    await driverFor(warm.metrics, fakeApi({ claimExists: true, mode: 'Running' })).launch(launchRequest)
    expect(await settled(() => warm.launches.length > 0)).toBe(true)
    expect(new Set(warm.stages.map((entry) => entry.path))).toEqual(new Set(['warm']))
  })

  it('tags the ORDINARY resume — launch, suspend, launch on one daemon — as a resume', async () => {
    // The common path, and the one the first version got wrong. `suspend()` keeps the cached
    // launch on purpose, so the second launch returns from ensureSandbox before any sandbox read:
    // the timer never saw a path and reported `warm`, excluding real resumes from resume p95.
    const seen = recorder()
    const driver = driverFor(seen.metrics, fakeApi({ claimExists: true, mode: 'Running' }))
    await driver.launch(launchRequest)
    expect(await settled(() => seen.launches.length === 1)).toBe(true)
    expect(seen.launches[0]?.path).toBe('warm')

    await driver.suspend('agent-a')
    await driver.launch(launchRequest)
    expect(await settled(() => seen.launches.length === 2)).toBe(true)
    expect(seen.launches[1]).toEqual(expect.objectContaining({ path: 'resume', outcome: 'ok' }))
    // No claim was submitted on this path, so there is no claim → bound duration to report.
    // Emitting a zero would put a sample in the distribution that never happened.
    const secondStages = seen.stages.slice(seen.stages.findIndex((entry) => entry.path === 'resume'))
    expect(secondStages.map((entry) => entry.stage)).not.toContain('claim_bound')
    expect(secondStages.every((entry) => entry.path === 'resume')).toBe(true)
  })

  it('closes runtime_ready when the ACP open resolves, and calls a failed open an error', async () => {
    // createRemoteRuntime only STARTS the open. Recording the stage on return measured the cost
    // of constructing a stream pair — a near-zero success for a runtime that never came up.
    const failed = recorder()
    const driver = driverFor(failed.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }), 'error')
    await driver.launch(launchRequest)
    expect(await settled(() => failed.launches.length > 0)).toBe(true)
    expect(failed.launches).toEqual([expect.objectContaining({ path: 'resume', outcome: 'error' })])

    // And exactly one sample: the failure path may also report, and two samples for one launch
    // is a corrupted distribution rather than a lost one.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(failed.launches).toHaveLength(1)
  })

  it('records NO runtime_ready stage for an open that never succeeded', async () => {
    // The stage histogram has no outcome attribute, so a failed open recorded as a completed
    // stage sits in the runtime-ready latency distribution as a fast success and cannot be
    // filtered back out. Only a successful open crossed that boundary.
    const failed = recorder()
    await driverFor(failed.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }), 'error').launch(launchRequest)
    expect(await settled(() => failed.launches.length > 0)).toBe(true)
    expect(failed.stages.map((entry) => entry.stage)).not.toContain('runtime_ready')
    expect(failed.launches).toEqual([expect.objectContaining({ outcome: 'error' })])
  })

  it('calls a runtime open that never answers a TIMEOUT, not an error', async () => {
    // A wedged runtime and one that refuses to start are different operational stories, and the
    // request deadline is what separates them — matched by type rather than by message text.
    const stuck = recorder()
    const clock = new FakeClock()
    await driverFor(stuck.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }), 'timeout', clock).launch(
      launchRequest
    )
    // The channel's own deadline is driven by this clock, so advancing past it is what fires.
    clock.advance(31_000)
    expect(await settled(() => stuck.launches.length > 0)).toBe(true)
    expect(stuck.launches).toEqual([expect.objectContaining({ path: 'resume', outcome: 'timeout' })])
    expect(stuck.stages.map((entry) => entry.stage)).not.toContain('runtime_ready')
  })

  it('puts ALL THREE launch deadlines in the timeout bucket, by type not by wording', async () => {
    // Claim bind, pod readiness and channel bind are three separate deadlines, and the message
    // regex this replaced silently stopped covering the channel wait as soon as its wording
    // changed — recording a genuine timeout as an error. Type-based classification cannot drift
    // that way, and asserting all three is what stops one of them slipping out again.
    const claimStuck = recorder()
    const noClaim = fakeApi({ claimExists: false, mode: 'Suspended' })
    noClaim.api.getClaim = async () => {
      throw new K8sApiError(404, 'NotFound', 'no claim')
    }
    noClaim.api.ensureClaim = async (claim: SandboxClaim & { metadata: { name: string } }) => ({
      claim,
      created: true
    })
    const claimClock = new FakeClock()
    const claimOutcome = await launchAdvancing(driverFor(claimStuck.metrics, noClaim, 'ok', claimClock), claimClock)
    expect(String(claimOutcome)).toMatch(/did not bind/)
    expect(claimStuck.launches).toEqual([expect.objectContaining({ outcome: 'timeout' })])

    const podStuck = recorder()
    const notReady = fakeApi({ claimExists: true, mode: 'Suspended' })
    notReady.api.getSandbox = async () =>
      ({
        metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
        spec: {
          operatingMode: notReady.state.mode,
          podTemplate: { spec: { containers: [{ name: 'runtime', image: 'runtime:1' }] } }
        },
        status: { conditions: [{ type: 'Ready', status: 'False' }] }
      }) as Sandbox
    const podClock = new FakeClock()
    const podOutcome = await launchAdvancing(driverFor(podStuck.metrics, notReady, 'ok', podClock), podClock)
    expect(String(podOutcome)).toMatch(/did not become ready/)
    expect(podStuck.launches).toEqual([expect.objectContaining({ path: 'resume', outcome: 'timeout' })])

    // The channel wait is the one the regex missed. Its host-supplied rejection lands at the
    // deadline we passed, which is the fact this driver owns.
    const channelStuck = recorder()
    const clock = new FakeClock()
    const late: AwaitChannel = async (_agentId, _generation, timeoutMs) => {
      clock.advance(timeoutMs)
      throw new Error('no channel bound in time')
    }
    await expect(
      driverFor(channelStuck.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }), 'ok', clock, late).launch(
        launchRequest
      )
    ).rejects.toThrow(/no shim channel bound/)
    expect(channelStuck.launches).toEqual([expect.objectContaining({ path: 'resume', outcome: 'timeout' })])
  })

  it('still calls a channel failure BEFORE the deadline an error', async () => {
    // Otherwise every channel problem would read as a missed latency target.
    const early = recorder()
    const failing: AwaitChannel = async () => {
      throw new Error('shim registry refused the bind')
    }
    await expect(
      driverFor(
        early.metrics,
        fakeApi({ claimExists: true, mode: 'Suspended' }),
        'ok',
        new FakeClock(),
        failing
      ).launch(launchRequest)
    ).rejects.toThrow(/registry refused/)
    expect(early.launches).toEqual([expect.objectContaining({ outcome: 'error' })])
  })

  it('records every stage of the launch, in order', async () => {
    const seen = recorder()
    await driverFor(seen.metrics, fakeApi({ claimExists: true, mode: 'Suspended' })).launch(launchRequest)
    expect(await settled(() => seen.launches.length > 0)).toBe(true)
    // A missing stage is worse than a wrong one: the dashboard silently attributes its time to
    // the next stage, which is how "the pull is slow" becomes "the pod is slow".
    expect(seen.stages.map((entry) => entry.stage)).toEqual([
      'claim_bound',
      'mode_running',
      'pod_ready',
      'shim_handshake',
      'runtime_ready'
    ])
    expect(seen.channels).toContain('bound')
  })

  it('counts a rejected guarded write as a retry rather than losing it in debug logs', async () => {
    const retried = recorder()
    const api = fakeApi({ claimExists: true, mode: 'Suspended' })
    let attempts = 0
    api.api.resumeWithRuntimeImage = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new GuardedResumeRejectedError('sb-1', new K8sApiError(422, 'Invalid', 'no'))
      }
      api.state.mode = 'Running'
      return {} as Sandbox
    }
    await driverFor(retried.metrics, api).launch(launchRequest)
    expect(retried.retries).toEqual(['rejected_precondition'])
  })

  it('counts a renewal as a re-establishment, separately from the first bind', async () => {
    const churn = recorder()
    const driver = driverFor(churn.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }))
    await driver.launch(launchRequest)
    // The routine half-TTL renewal: the daemon reconnects and hands the SAME launch its
    // replacement socket, with no loss reported in between. A re-establishment rate is the signal
    // that renewals or pod churn exceed expectations, which pooling it with the first bind hides.
    driver.onChannelBound(rebind())
    expect(churn.channels).toEqual(['bound', 'reestablished'])
  })

  it('does not count a bind arriving after the launch was already lost', async () => {
    const churn = recorder()
    const driver = driverFor(churn.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }))
    await driver.launch(launchRequest)
    driver.onChannelLost('agent-a', 'socket closed')
    // Loss is terminal and ends the launch, so a socket that arrives after it belongs to nothing:
    // its session is gone and the next turn claims a new generation. Counting it as a
    // re-establishment would report a recovery that did not happen.
    driver.onChannelBound(rebind())
    expect(churn.channels).toEqual(['bound', 'dropped'])
  })
})

describe('LaunchTimer', () => {
  it('measures each stage from the previous boundary, not from the start', () => {
    // Cumulative timings answer "which stage is slow" only by subtraction, and a dashboard that
    // has to subtract is a dashboard nobody trusts.
    const seen = recorder()
    let now = 1_000
    const timer = new LaunchTimer(seen.metrics, () => now)
    timer.observedPath('resume')
    now = 1_400
    timer.mark('claim_bound')
    now = 1_900
    timer.mark('pod_ready')
    timer.finish('ok')
    expect(seen.stages).toEqual([
      { stage: 'claim_bound', path: 'resume', durationMs: 400 },
      { stage: 'pod_ready', path: 'resume', durationMs: 500 }
    ])
    // The total is recorded independently, so it does not depend on the stages being complete.
    expect(seen.launches).toEqual([{ path: 'resume', outcome: 'ok', durationMs: 900 }])
  })

  it('holds a stage measured before the path is known, then emits it under that path', () => {
    // claim → bound is the stage that carries PVC provisioning, and it completes BEFORE the
    // sandbox read that reveals the path. Emitting it provisionally filed cold-start time under
    // `warm` — the first version of this did exactly that, and this test is why it is not shipped.
    const seen = recorder()
    let now = 0
    const timer = new LaunchTimer(seen.metrics, () => now)
    now = 50
    timer.mark('claim_bound')
    expect(seen.stages).toEqual([])
    timer.observedPath('cold')
    expect(seen.stages).toEqual([{ stage: 'claim_bound', path: 'cold', durationMs: 50 }])
  })

  it('reports a launch that failed before its path was known as neither cold nor resume', () => {
    const seen = recorder()
    let now = 0
    const timer = new LaunchTimer(seen.metrics, () => now)
    now = 30
    timer.mark('claim_bound')
    now = 40
    timer.finish('timeout')
    // Nothing was created and nothing resumed, so charging it to either target would be a claim
    // the daemon cannot support.
    expect(seen.stages).toEqual([{ stage: 'claim_bound', path: 'warm', durationMs: 30 }])
    expect(seen.launches).toEqual([{ path: 'warm', outcome: 'timeout', durationMs: 40 }])
  })
})
