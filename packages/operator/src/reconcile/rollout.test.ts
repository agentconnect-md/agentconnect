import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { loadConfig } from '../config.js'
import { AgentConnectOrgApi } from '../crd/api.js'
import { AgentConnectOrgSpecSchema, DRAIN_REQUESTED_ANNOTATION } from '../crd/types.js'
import { newObservations, type ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { reconcileRollout } from './rollout.js'

afterEach(closeFakeApiServers)

const NS = 'test-ac-org-acme'
const TARGET = 'ghcr.io/example/runtime:v2'

function inputOf(): EnvelopeInputs {
  return {
    orgName: 'acme',
    spec: AgentConnectOrgSpecSchema.parse({
      targetNamespace: NS,
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
  sandboxes: unknown[]
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
    log: {}
  }
  const obs = newObservations()
  obs.namespaceReady = true
  await reconcileRollout(ctx, inputOf(), obs)
  return { patches, obs }
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
    const body = patches[0].body as { metadata: { annotations: Record<string, string> } }
    const value = body.metadata.annotations[DRAIN_REQUESTED_ANNOTATION]
    expect(value.endsWith(`/${TARGET}`)).toBe(true)
    expect(obs.rollout?.pending).toEqual(['sb-1'])
  })

  it('does not repeat an annotation that is already requested', async () => {
    const first = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running')])
    const annotated = (first.patches[0].body as { metadata: { annotations: Record<string, string> } }).metadata
      .annotations
    const { patches } = await run([sandbox('sb-1', 'ghcr.io/example/runtime:v1', 'Running', annotated)])
    expect(patches).toEqual([])
  })

  it('sweeps a stale annotation once the sandbox reaches the target image', async () => {
    const { patches, obs } = await run([
      sandbox('sb-1', TARGET, 'Running', { [DRAIN_REQUESTED_ANNOTATION]: 'old/ghcr.io/example/runtime:v1' })
    ])
    expect(patches).toHaveLength(1)
    const body = patches[0].body as { metadata: { annotations: Record<string, null> } }
    expect(body.metadata.annotations[DRAIN_REQUESTED_ANNOTATION]).toBeNull()
    expect(obs.rollout).toBeUndefined()
  })

  it('reports no rollout when every sandbox is on the target image', async () => {
    const { patches, obs } = await run([sandbox('sb-1', TARGET, 'Running')])
    expect(patches).toEqual([])
    expect(obs.rollout).toBeUndefined()
  })
})
