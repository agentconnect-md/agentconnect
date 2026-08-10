import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FakeClock } from '@agentconnect.md/connection'
import { ClusterSpawnDriver, DRAIN_REQUESTED_ANNOTATION } from '../src/k8s/cluster-driver.js'
import { LaunchTimer, type ClusterMetrics, type LaunchPath, type LaunchStage } from '../src/k8s/cluster-metrics.js'
import { K8sApiError } from '../src/k8s/http.js'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'

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
          spec: { operatingMode: state.mode },
          status: { conditions: [{ type: 'Ready', status: 'True' }] }
        }) as Sandbox,
      setOperatingMode: async (_name: string, desired: 'Running' | 'Suspended') => {
        state.mode = desired
        return {} as Sandbox
      },
      watchClaims: vi.fn(),
      watchSandboxes: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

/**
 * A connection that ANSWERS the ACP open, because the runtime-ready stage closes when the open
 * resolves — not when `launch()` returns. A silent fake made that stage measure the cost of
 * constructing a stream pair, which is how a runtime that never started looked like a success.
 */
function respondingConnection(outcome: 'ok' | 'error') {
  const listeners: Array<(text: string) => void> = []
  return {
    binding: { agentId: 'agent-a', generation: 1, grants: ['acp'], podName: 'p', podUid: 'u' },
    issuedCredential: 'cred',
    send: (frame: { type: string; id: string }) => {
      if (frame.type !== 'shim/request') return
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

function driverFor(metrics: ClusterMetrics, api: ReturnType<typeof fakeApi>, open: 'ok' | 'error' = 'ok') {
  return new ClusterSpawnDriver({
    api: api.api as never,
    orgId: 'org-1',
    warmPoolName: 'pool',
    publishSpawnRecord: () => {},
    awaitChannel: async () => respondingConnection(open) as never,
    clock: new FakeClock(),
    metrics,
    readyTimeoutMs: 5_000,
    log: { info: () => {}, warn: () => {}, debug: () => {} }
  })
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

  it('distinguishes a draining refusal from a timeout and from an error', async () => {
    const drained = recorder()
    const api = fakeApi({ claimExists: true, mode: 'Suspended' })
    const driver = driverFor(drained.metrics, api)
    driver.onSandboxObserved('agent-a', { [DRAIN_REQUESTED_ANNOTATION]: 'rollout-1' })
    await expect(driver.launch(launchRequest)).rejects.toThrow(/draining/)
    // Held-for-rollout is not a missed target, and pooling it with errors would make a rollout
    // look like an outage on the dashboard.
    expect(drained.launches).toEqual([expect.objectContaining({ outcome: 'draining' })])
  })

  it('counts a rejected guarded write as a retry rather than losing it in debug logs', async () => {
    const retried = recorder()
    const api = fakeApi({ claimExists: true, mode: 'Suspended' })
    let attempts = 0
    api.api.setOperatingMode = async (_name: string, desired: 'Running' | 'Suspended') => {
      attempts += 1
      if (attempts === 1) {
        const { OperatingModeRejectedError } = await import('../src/k8s/sandbox-api.js')
        throw new OperatingModeRejectedError('sb-1', 'Suspended', desired, new K8sApiError(422, 'Invalid', 'no'))
      }
      api.state.mode = desired
      return {} as Sandbox
    }
    await driverFor(retried.metrics, api).launch(launchRequest)
    expect(retried.retries).toEqual(['rejected_precondition'])
  })

  it('counts a channel drop and a re-establishment separately', async () => {
    const churn = recorder()
    const driver = driverFor(churn.metrics, fakeApi({ claimExists: true, mode: 'Suspended' }))
    await driver.launch(launchRequest)
    driver.onChannelLost('agent-a', 'socket closed')
    driver.onChannelBound({
      binding: { agentId: 'agent-a', generation: 1, grants: ['acp'], podName: 'p', podUid: 'u' },
      issuedCredential: 'cred-2',
      send: () => {},
      onFrame: () => {},
      close: () => {}
    } as never)
    // A re-establishment rate is the signal that renewals or pod churn exceed expectations,
    // which pooling it with the first bind would hide.
    expect(churn.channels).toEqual(['bound', 'dropped', 'reestablished'])
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
