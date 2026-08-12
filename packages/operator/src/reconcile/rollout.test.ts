import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { AgentConnectOrgSpecSchema, DRAIN_REQUESTED_ANNOTATION, DRAIN_REQUESTED_AT_ANNOTATION } from '../crd/types.js'
import { newObservations, type ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { DRAIN_TIMEOUT_MS, reconcileRollout } from './rollout.js'

afterEach(closeFakeApiServers)

const NS = 'test-ac-org-acme'
const TARGET = 'ghcr.io/example/runtime:v2'
const START = Date.parse('2026-01-01T00:00:00.000Z')

function inputOf(): EnvelopeInputs {
  return {
    orgName: 'acme',
    namespace: NS,
    spec: AgentConnectOrgSpecSchema.parse({
      daemon: { image: 'ghcr.io/example/daemon:v1', tier: 'small' },
      runtime: { image: TARGET, tiers: [{ name: 'std' }] }
    })
  }
}

function sandbox(name: string, image: string, mode?: string, annotations?: Record<string, string>) {
  return {
    metadata: { name, ...(annotations ? { annotations } : {}) },
    spec: { ...(mode ? { operatingMode: mode } : {}), podTemplate: { spec: { containers: [{ image }] } } }
  }
}

interface RecordedPatch {
  path: string
  contentType?: string
  body: unknown
}

async function run(
  sandboxes: unknown[],
  clock: FakeClock = new FakeClock(START)
): Promise<{ patches: RecordedPatch[]; obs: ReturnType<typeof newObservations> }> {
  const patches: RecordedPatch[] = []
  const route: FakeRoute = ({ method, url, body, headers }) => {
    if (method === 'GET') return { json: { items: sandboxes } }
    const contentType = headers['content-type']
    patches.push({
      path: url.pathname,
      contentType: Array.isArray(contentType) ? contentType[0] : contentType,
      body: body ? JSON.parse(body) : undefined
    })
    return { json: {} }
  }
  const { config: cluster } = await fakeApiServer(route)
  const http = new K8sHttp(cluster)
  const ctx: ReconcileContext = {
    http,
    orgApi: new AgentConnectOrgApi(http, cluster.namespace),
    config: loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'x' }),
    controlNamespace: cluster.namespace,
    clock,
    log: {}
  }
  const obs = newObservations()
  obs.namespaceReady = true
  await reconcileRollout(ctx, inputOf(), obs)
  return { patches, obs }
}

/** The annotations a drain request wrote, read back off the recorded merge patch. */
function requestedAnnotations(patch: RecordedPatch): Record<string, string | null> {
  return (patch.body as { metadata: { annotations: Record<string, string | null> } }).metadata.annotations
}

describe('reconcileRollout', () => {
  it('patches a Suspended sandbox with a conditioned image swap', async () => {
    const { patches, obs } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Suspended')])
    expect(patches).toHaveLength(1)
    expect(patches[0].contentType).toBe('application/json-patch+json')
    expect(patches[0].body).toEqual([
      { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
      { op: 'replace', path: '/spec/podTemplate/spec/containers/0/image', value: TARGET }
    ])
    expect(obs.rollout?.pending).toEqual(['sb-1'])
    expect(obs.rollout?.targetImage).toBe(TARGET)
  })

  it('asks a Running sandbox to drain via the annotation handshake, never a forced suspend', async () => {
    const { patches, obs } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running')])
    expect(patches).toHaveLength(1)
    // A PATCH that does not name its patch type is a 415 from a real API server.
    expect(patches[0].contentType).toBe('application/merge-patch+json')
    const annotations = requestedAnnotations(patches[0])
    expect(annotations[DRAIN_REQUESTED_ANNOTATION]?.endsWith(`/${TARGET}`)).toBe(true)
    // The deadline is measured from a time on the OBJECT, so a leader change does not restart it.
    expect(annotations[DRAIN_REQUESTED_AT_ANNOTATION]).toBe(new Date(START).toISOString())
    expect(obs.rollout?.pending).toEqual(['sb-1'])
    expect(obs.rollout?.failed).toEqual([])
  })

  it('does not repeat an annotation that is already requested', async () => {
    const first = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running')])
    const annotated = requestedAnnotations(first.patches[0]) as Record<string, string>
    const { patches } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', annotated)])
    expect(patches).toEqual([])
  })

  it('starts the deadline now when the request carries no readable time', async () => {
    // An older operator, or a hand-edited object: expiring against a time nobody wrote would
    // either fail the instance instantly or never.
    const { patches, obs } = await run([
      sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', {
        [DRAIN_REQUESTED_ANNOTATION]: `${'0'.repeat(8)}/${TARGET}`
      })
    ])
    expect(requestedAnnotations(patches[0])[DRAIN_REQUESTED_AT_ANNOTATION]).toBe(new Date(START).toISOString())
    expect(obs.rollout?.pending).toEqual(['sb-1'])
  })

  it('fails an instance that is still Running when its drain deadline passes', async () => {
    const clock = new FakeClock(START)
    const requested = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running')], clock)
    const annotated = requestedAnnotations(requested.patches[0]) as Record<string, string>
    clock.advance(DRAIN_TIMEOUT_MS)
    const { patches, obs } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', annotated)], clock)
    // Failed is terminal for this target: nothing is re-requested, and it stays listed.
    expect(patches).toEqual([])
    expect(obs.rollout?.failed).toEqual(['sb-1'])
    expect(obs.rollout?.pending).toEqual([])
  })

  it('keeps a drain pending right up to its deadline', async () => {
    const clock = new FakeClock(START)
    const requested = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running')], clock)
    const annotated = requestedAnnotations(requested.patches[0]) as Record<string, string>
    clock.advance(DRAIN_TIMEOUT_MS - 1)
    const { obs } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', annotated)], clock)
    expect(obs.rollout?.pending).toEqual(['sb-1'])
    expect(obs.rollout?.failed).toEqual([])
  })

  it('re-requests a failed instance when the target image changes', async () => {
    // A new target is a new rolloutId, so the handshake starts over rather than staying failed
    // against an image nobody is rolling out any more.
    const clock = new FakeClock(START)
    clock.advance(DRAIN_TIMEOUT_MS * 2)
    const { patches, obs } = await run(
      [
        sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', {
          [DRAIN_REQUESTED_ANNOTATION]: 'older001/ghcr.io/example/runtime:v0',
          [DRAIN_REQUESTED_AT_ANNOTATION]: new Date(START).toISOString()
        })
      ],
      clock
    )
    expect(requestedAnnotations(patches[0])[DRAIN_REQUESTED_ANNOTATION]?.endsWith(`/${TARGET}`)).toBe(true)
    expect(obs.rollout?.pending).toEqual(['sb-1'])
    expect(obs.rollout?.failed).toEqual([])
  })

  it('sweeps a stale annotation once the sandbox reaches the target image', async () => {
    const { patches, obs } = await run([
      sandbox('sb-1', TARGET, 'Running', {
        [DRAIN_REQUESTED_ANNOTATION]: `old/ghcr.io/example/runtime:v1`,
        [DRAIN_REQUESTED_AT_ANNOTATION]: new Date(START).toISOString()
      })
    ])
    expect(patches).toHaveLength(1)
    expect(patches[0].contentType).toBe('application/merge-patch+json')
    // Both halves go: a left-over request would keep the daemon refusing to wake the instance.
    expect(requestedAnnotations(patches[0])).toEqual({
      [DRAIN_REQUESTED_ANNOTATION]: null,
      [DRAIN_REQUESTED_AT_ANNOTATION]: null
    })
    expect(obs.rollout).toBeUndefined()
  })

  it('reports no rollout when every sandbox is on the target image', async () => {
    const { patches, obs } = await run([sandbox('sb-1', TARGET, 'Running')])
    expect(patches).toEqual([])
    expect(obs.rollout).toBeUndefined()
  })
})
