import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import type { AgentConnectOrg, Condition } from '../crd/types.js'
import { newObservations, type Observations } from './context.js'
import { buildStatus, setCondition, writeStatus, CREDENTIAL_RECHECK_MS } from './status.js'

afterEach(closeFakeApiServers)

const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'

function orgOf(overrides: Partial<AgentConnectOrg> = {}): AgentConnectOrg {
  return { metadata: { name: 'acme', generation: 3 }, ...overrides }
}

function healthyObs(): Observations {
  const obs = newObservations()
  obs.namespaceReady = true
  obs.namespace = 'test-ac-org-acme'
  obs.daemon = { ready: true, image: 'ghcr.io/example/daemon:v1' }
  obs.credential = { status: 'True', reason: 'DaemonRunning' }
  obs.sandboxes = { total: 2, running: 1, suspended: 1 }
  return obs
}

const byType = (status: { conditions?: Condition[] }, type: string): Condition | undefined =>
  status.conditions?.find((condition) => condition.type === type)

describe('buildStatus', () => {
  it('publishes namespace atomically with NamespaceReady and reports Ready', () => {
    const status = buildStatus(orgOf(), healthyObs(), NOW)
    expect(status.namespace).toBe('test-ac-org-acme')
    expect(status.observedGeneration).toBe(3)
    expect(byType(status, 'NamespaceReady')?.status).toBe('True')
    expect(byType(status, 'Ready')?.status).toBe('True')
    expect(byType(status, 'Degraded')?.status).toBe('False')
    expect(byType(status, 'LimitsApplied')?.status).toBe('Unknown')
    expect(status.sandboxes).toEqual({ total: 2, running: 1, suspended: 1 })
  })

  it('withholds the namespace and degrades on a namespace fault', () => {
    const obs = newObservations()
    obs.degraded = { reason: 'NamespaceClaimConflict', message: 'refusing to adopt' }
    const status = buildStatus(orgOf(), obs, NOW)
    expect(status.namespace).toBeUndefined()
    expect(byType(status, 'NamespaceReady')?.status).toBe('False')
    expect(byType(status, 'NamespaceReady')?.reason).toBe('NamespaceClaimConflict')
    expect(byType(status, 'Degraded')?.status).toBe('True')
    expect(byType(status, 'Ready')?.status).toBe('False')
  })

  it('reports a suspended org as not Ready with reason Suspended', () => {
    const org = orgOf()
    org.spec = { suspend: true } as AgentConnectOrg['spec']
    const status = buildStatus(org, healthyObs(), NOW)
    expect(byType(status, 'Ready')?.status).toBe('False')
    expect(byType(status, 'Ready')?.reason).toBe('Suspended')
  })

  it('surfaces tier warnings as Degraded without blocking Ready-relevant conditions', () => {
    const obs = healthyObs()
    obs.warnings.push('master template ac-runtime-big not found')
    const status = buildStatus(orgOf(), obs, NOW)
    expect(byType(status, 'Degraded')?.status).toBe('True')
    expect(byType(status, 'Degraded')?.reason).toBe('EnvelopeWarning')
  })

  it('keeps lastTransitionTime when a condition status does not flip', () => {
    const first = buildStatus(orgOf(), healthyObs(), NOW)
    const org = orgOf({ status: first })
    const second = buildStatus(org, healthyObs(), LATER)
    expect(byType(second, 'Ready')?.lastTransitionTime).toBe(NOW)
    const degradedObs = healthyObs()
    degradedObs.daemon = { ready: false }
    const third = buildStatus(orgOf({ status: second }), degradedObs, LATER)
    expect(byType(third, 'Ready')?.status).toBe('False')
    expect(byType(third, 'Ready')?.lastTransitionTime).toBe(LATER)
  })

  it('carries the credential message onto the CredentialReady condition', () => {
    const obs = healthyObs()
    obs.credential = {
      status: 'False',
      reason: 'CredentialSecretMissing',
      message: 'daemon pod cannot mount credential secret ac-daemon-token'
    }
    const condition = byType(buildStatus(orgOf(), obs, NOW), 'CredentialReady')
    expect(condition?.status).toBe('False')
    expect(condition?.reason).toBe('CredentialSecretMissing')
    expect(condition?.message).toContain('ac-daemon-token')
  })

  it('marks Progressing during a runtime rollout and carries the rollout record', () => {
    const obs = healthyObs()
    obs.rollout = { rolloutId: 'abc123', targetImage: 'ghcr.io/example/runtime:v2', pending: ['sb-1'], failed: [] }
    const status = buildStatus(orgOf(), obs, NOW)
    expect(byType(status, 'Progressing')?.status).toBe('True')
    expect(byType(status, 'Progressing')?.reason).toBe('RuntimeRollout')
    expect(status.rollout?.pending).toEqual(['sb-1'])
  })
})

describe('observeWorkloads', () => {
  interface ObserveOptions {
    pods?: unknown[]
    events?: unknown[]
    /** Non-2xx status for the events endpoint — an install whose RBAC predates the read. */
    eventsStatus?: number
    daemonSpec?: Record<string, unknown>
    suspend?: boolean
    /** Any other collection this case cares about, keyed off the request path. */
    extra?: (path: string) => object | undefined
  }

  async function observe(deployment: unknown, options: ObserveOptions = {}) {
    const { pods = [], events = [], eventsStatus, daemonSpec = {}, suspend = false } = options
    const extra = options.extra ?? (() => undefined)
    const { config: cluster, requests } = await fakeApiServer(({ url }) => {
      const path = url.pathname
      if (path.endsWith('/deployments/ac-daemon')) return { json: deployment as object }
      if (path.endsWith('/pods')) return { json: { items: pods } }
      if (path.endsWith('/events'))
        return eventsStatus ? { status: eventsStatus, json: { message: 'forbidden' } } : { json: { items: events } }
      return { json: extra(path) ?? { items: [] } }
    })
    const http = new K8sHttp(cluster)
    const warnings: string[] = []
    const ctx = {
      http,
      orgApi: new AgentConnectOrgApi(http, cluster.namespace),
      config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
      controlNamespace: cluster.namespace,
      log: { warn: (message: string) => warnings.push(message) }
    }
    const obs = newObservations()
    const { AgentConnectOrgSpecSchema } = await import('../crd/types.js')
    const input = {
      orgName: 'acme',
      spec: AgentConnectOrgSpecSchema.parse({
        targetNamespace: 'test-ac-org-acme',
        suspend,
        daemon: { image: 'ghcr.io/example/daemon:v2', tier: 'small', ...daemonSpec },
        runtime: { image: 'x', tiers: [] }
      })
    }
    const { observeWorkloads } = await import('./status.js')
    await observeWorkloads(ctx, input, obs)
    return { obs, requests, warnings }
  }

  /** The kubelet's own wording for a Secret-backed volume it cannot mount; re-emitted while it keeps failing. */
  const failedMountEvent = (podName: string, message: string, agoMs = 30_000) => ({
    reason: 'FailedMount',
    involvedObject: { kind: 'Pod', name: podName },
    message,
    lastTimestamp: new Date(Date.now() - agoMs).toISOString()
  })

  const convergedDeployment = {
    metadata: { generation: 2 },
    spec: { replicas: 1, template: { spec: { containers: [{ image: 'ghcr.io/example/daemon:v2' }] } } },
    status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1 }
  }

  /** A pod the kubelet has accepted but whose containers are still not up. */
  const startingPod = (name = 'ac-daemon-0') => ({
    metadata: { name },
    status: {
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ ready: false, state: { waiting: { reason: 'ContainerCreating' } } }]
    }
  })

  /** A daemon pod blocked at Init:0/1: with an init container declared, every uncreated one reads PodInitializing. */
  const initBlockedPod = (name = 'ac-daemon-0') => ({
    metadata: { name },
    status: {
      phase: 'Pending',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Initialized', status: 'False', reason: 'ContainersNotInitialized' }
      ],
      initContainerStatuses: [{ ready: false, state: { waiting: { reason: 'PodInitializing' } } }],
      containerStatuses: [{ ready: false, state: { waiting: { reason: 'PodInitializing' } } }]
    }
  })

  it('does not report the target image Ready off the old pod`s stale readyReplicas', async () => {
    // Image just swapped: generation advanced, but readyReplicas still counts the old pod.
    const { obs } = await observe({
      metadata: { generation: 2 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'ghcr.io/example/daemon:v2' }] } } },
      status: { observedGeneration: 1, readyReplicas: 1, updatedReplicas: 0 }
    })
    expect(obs.daemon?.ready).toBe(false)
    expect(obs.progressing).toBe(true)
  })

  it('reports Ready once the updated pod itself is the ready one', async () => {
    const { obs } = await observe({
      metadata: { generation: 2 },
      spec: { replicas: 1, template: { spec: { containers: [{ image: 'ghcr.io/example/daemon:v2' }] } } },
      status: { observedGeneration: 2, readyReplicas: 1, updatedReplicas: 1 }
    })
    expect(obs.daemon?.ready).toBe(true)
    expect(obs.progressing).toBe(false)
  })

  it('summarizes warm pools from readyReplicas and counts bound claims per pool', async () => {
    const { obs } = await observe(
      { spec: { replicas: 1 } },
      {
        extra: (path) => {
          if (path.endsWith('/sandboxwarmpools'))
            return {
              items: [
                { metadata: { name: 'ac-runtime-small' }, status: { replicas: 3, readyReplicas: 2 } },
                // A pool the vendor has not populated yet: status carries the selector only.
                { metadata: { name: 'ac-runtime-large' }, status: { selector: 'warm-pool-sandbox=abc' } }
              ]
            }
          if (path.endsWith('/sandboxclaims'))
            return {
              items: [
                { spec: { warmPoolRef: { name: 'ac-runtime-small' } }, status: { sandbox: { name: 'sb-1' } } },
                { spec: { warmPoolRef: { name: 'ac-runtime-small' } }, status: { sandbox: { name: 'sb-2' } } },
                // Not bound yet — it holds no Sandbox, so it is not claimed capacity.
                { spec: { warmPoolRef: { name: 'ac-runtime-small' } }, status: {} },
                { spec: { warmPoolRef: { name: 'ac-runtime-large' } }, status: { sandbox: { name: 'sb-3' } } }
              ]
            }
          return undefined
        }
      }
    )
    expect(obs.pools).toEqual([
      { name: 'ac-runtime-small', warmAvailable: 2, claimed: 2 },
      { name: 'ac-runtime-large', warmAvailable: 0, claimed: 1 }
    ])
  })

  it('does not list claims when the namespace has no warm pools', async () => {
    const { obs, requests } = await observe({ spec: { replicas: 1 } })
    expect(obs.pools).toEqual([])
    expect(requests.some((url) => url.pathname.endsWith('/sandboxclaims'))).toBe(false)
  })

  it('reports CredentialReady Unknown when no daemon pod exists yet', async () => {
    const { obs } = await observe(convergedDeployment)
    expect(obs.credential).toEqual({ status: 'Unknown', reason: 'NoDaemonPod' })
  })

  it('reports CredentialReady True once every container of a pod is ready', async () => {
    const pod = {
      metadata: { name: 'ac-daemon-0' },
      status: { phase: 'Running', containerStatuses: [{ ready: true }] }
    }
    const { obs } = await observe(convergedDeployment, { pods: [pod] })
    expect(obs.credential).toEqual({ status: 'True', reason: 'DaemonRunning' })
  })

  it('names the credential secret when the kubelet cannot build the init container config', async () => {
    // The Secret is mounted by the init container alone, so only its status carries the error.
    const pod = {
      metadata: { name: 'ac-daemon-0' },
      status: {
        phase: 'Pending',
        initContainerStatuses: [{ ready: false, state: { waiting: { reason: 'CreateContainerConfigError' } } }],
        containerStatuses: [{ ready: false, state: { waiting: { reason: 'PodInitializing' } } }]
      }
    }
    const { obs } = await observe(convergedDeployment, {
      pods: [pod],
      daemonSpec: { credentialSecretName: 'org-daemon-credentials' }
    })
    expect(obs.credential?.status).toBe('False')
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
    expect(obs.credential?.message).toContain('org-daemon-credentials')
  })

  it('reads the FailedMount event while the pod is still stuck at init', async () => {
    // The live shape: containers all PodInitializing, the mount failure named only by the kubelet's event.
    const { obs } = await observe(convergedDeployment, {
      pods: [initBlockedPod()],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential?.status).toBe('False')
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
    expect(obs.credential?.message).toContain('ac-daemon-token')
    expect(obs.recheckAfterMs).toBeUndefined()
  })

  it('reads the FailedMount event before the kubelet reports any container at all', async () => {
    const bare = { metadata: { name: 'ac-daemon-0' }, status: { phase: 'Pending' } }
    const { obs } = await observe(convergedDeployment, {
      pods: [bare],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
  })

  it('drops the event when the init container is stuck on a blocker of its own', async () => {
    // Mount fixed, the init image is the new blocker; the main container's PodInitializing must not re-blame it.
    const pulling = {
      metadata: { name: 'ac-daemon-0' },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'True' }],
        initContainerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }],
        containerStatuses: [{ ready: false, state: { waiting: { reason: 'PodInitializing' } } }]
      }
    }
    const { obs } = await observe(convergedDeployment, {
      pods: [pulling],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('reads the pod`s FailedMount event as the missing credential secret, not a startup delay', async () => {
    const { obs, requests } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential?.status).toBe('False')
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
    expect(obs.credential?.message).toContain('ac-daemon-token')
    // Scoped server-side to the one reason worth reading, so the pass never lists a namespace's whole event stream.
    const eventQuery = requests.find((url) => url.pathname.endsWith('/events'))?.searchParams.get('fieldSelector')
    expect(eventQuery).toBe('involvedObject.kind=Pod,reason=FailedMount')
  })

  it('does not blame the credential for another volume`s mount failure', async () => {
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "state" : timed out waiting for the condition'
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('accepts the events.k8s.io series heartbeat as the occurrence time', async () => {
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        {
          reason: 'FailedMount',
          involvedObject: { kind: 'Pod', name: 'ac-daemon-0' },
          message: 'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found',
          eventTime: new Date(Date.now() - 20 * 60_000).toISOString(),
          series: { lastObservedTime: new Date(Date.now() - 30_000).toISOString() }
        }
      ]
    })
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
  })

  it('still believes a persistent failure whose events the recorder has throttled', async () => {
    // Correlator burst drained: one admitted update per five minutes, so ~6 min between visible timestamps.
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found',
          6 * 60_000
        )
      ]
    })
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
  })

  it('lets a retained event go stale instead of describing a mount that was fixed', async () => {
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found',
          30 * 60_000
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('drops the event once the pod is stuck on something other than creating its containers', async () => {
    // Secret created, mount succeeded, image is the new blocker — the retained event must not keep the old reason.
    const pulling = {
      metadata: { name: 'ac-daemon-0' },
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'True' }],
        initContainerStatuses: [{ ready: false, state: { waiting: { reason: 'ImagePullBackOff' } } }]
      }
    }
    const { obs } = await observe(convergedDeployment, {
      pods: [pulling],
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('does not blame a credential whose name merely appears in another object`s failure', async () => {
    // A Secret named `state` shares its name with the daemon PVC's volume; only a Secret reference counts.
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      daemonSpec: { credentialSecretName: 'state' },
      events: [
        failedMountEvent(
          'ac-daemon-0',
          'MountVolume.SetUp failed for volume "state" : persistentvolumeclaim "ac-daemon-state" not found'
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('accepts the namespaced wording the kubelet also uses for an unreadable secret', async () => {
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [failedMountEvent('ac-daemon-0', "Couldn't get secret test-ac-org-acme/ac-daemon-token: not found")]
    })
    expect(obs.credential?.reason).toBe('CredentialSecretMissing')
  })

  it('ignores a FailedMount event belonging to some other pod', async () => {
    const { obs } = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [
        failedMountEvent(
          'ac-runtime-7',
          'MountVolume.SetUp failed for volume "config" : secret "ac-daemon-token" not found'
        )
      ]
    })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
  })

  it('keeps the status pass alive when the events read is forbidden', async () => {
    const { obs, warnings } = await observe(convergedDeployment, { pods: [startingPod()], eventsStatus: 403 })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
    expect(warnings.some((warning) => warning.includes('FailedMount'))).toBe(true)
    // The rest of the pass still ran.
    expect(obs.daemon?.ready).toBe(true)
  })

  it('reports an unscheduled pod as Unknown rather than blaming the credential', async () => {
    const pod = {
      metadata: { name: 'ac-daemon-0' },
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] }
    }
    const { obs, requests } = await observe(convergedDeployment, { pods: [pod] })
    expect(obs.credential?.status).toBe('Unknown')
    expect(obs.credential?.reason).toBe('DaemonPodUnschedulable')
    // No kubelet ever saw the pod, so the events read is skipped entirely.
    expect(requests.some((url) => url.pathname.endsWith('/events'))).toBe(false)
  })

  it('keeps an ordinary not-ready pod on DaemonPodNotReady and asks for one more look', async () => {
    const { obs } = await observe(convergedDeployment, { pods: [startingPod()] })
    expect(obs.credential).toEqual({ status: 'False', reason: 'DaemonPodNotReady' })
    // The FailedMount event can be written after the pod's last update, which no watch would wake us for.
    expect(obs.recheckAfterMs).toBe(CREDENTIAL_RECHECK_MS)
  })

  it('asks for no follow-up once the verdict is settled', async () => {
    const ready = {
      metadata: { name: 'ac-daemon-0' },
      status: { phase: 'Running', containerStatuses: [{ ready: true }] }
    }
    expect((await observe(convergedDeployment, { pods: [ready] })).obs.recheckAfterMs).toBeUndefined()
    const blocked = await observe(convergedDeployment, {
      pods: [startingPod()],
      events: [failedMountEvent('ac-daemon-0', 'secret "ac-daemon-token" not found')]
    })
    expect(blocked.obs.recheckAfterMs).toBeUndefined()
  })

  it('reports a suspended org as Unknown without inspecting pods', async () => {
    const { obs } = await observe(convergedDeployment, { pods: [startingPod()], suspend: true })
    expect(obs.credential).toEqual({ status: 'Unknown', reason: 'Suspended' })
  })
})

describe('writeStatus', () => {
  it('nulls every managed field this pass did not observe so merge-patch cannot go stale', async () => {
    let patched: { status?: Record<string, unknown> } | undefined
    const { config: cluster } = await fakeApiServer(({ method, body }) => {
      if (method === 'PATCH') patched = JSON.parse(body) as typeof patched
      return { json: {} }
    })
    const http = new K8sHttp(cluster)
    const ctx = {
      http,
      orgApi: new AgentConnectOrgApi(http, cluster.namespace),
      config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
      controlNamespace: cluster.namespace,
      log: {}
    }
    // A pass that lost the namespace claim: previous status carried namespace + summaries.
    const org = orgOf({ status: { namespace: 'test-ac-org-acme', daemon: { ready: true } } })
    const obs = newObservations()
    obs.degraded = { reason: 'NamespaceClaimConflict', message: 'refusing to adopt' }
    await writeStatus(ctx, org, obs, NOW)
    expect(patched?.status?.namespace).toBeNull()
    expect(patched?.status?.daemon).toBeNull()
    expect(patched?.status?.sandboxes).toBeNull()
    expect(patched?.status?.rollout).toBeNull()
    expect(patched?.status?.conditions).toBeDefined()
  })

  it('keeps observed fields as values, not nulls', async () => {
    let patched: { status?: Record<string, unknown> } | undefined
    const { config: cluster } = await fakeApiServer(({ method, body }) => {
      if (method === 'PATCH') patched = JSON.parse(body) as typeof patched
      return { json: {} }
    })
    const http = new K8sHttp(cluster)
    const ctx = {
      http,
      orgApi: new AgentConnectOrgApi(http, cluster.namespace),
      config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
      controlNamespace: cluster.namespace,
      log: {}
    }
    await writeStatus(ctx, orgOf(), healthyObs(), NOW)
    expect(patched?.status?.namespace).toBe('test-ac-org-acme')
    expect(patched?.status?.daemon).toEqual({ ready: true, image: 'ghcr.io/example/daemon:v1' })
    expect(patched?.status?.pools).toBeNull()
  })
})

describe('setCondition', () => {
  it('advances lastTransitionTime only on a status flip', () => {
    const start = setCondition([], { type: 'Ready', status: 'True' }, NOW)
    const same = setCondition(start, { type: 'Ready', status: 'True' }, LATER)
    expect(same[0].lastTransitionTime).toBe(NOW)
    const flipped = setCondition(same, { type: 'Ready', status: 'False' }, LATER)
    expect(flipped[0].lastTransitionTime).toBe(LATER)
  })
})
