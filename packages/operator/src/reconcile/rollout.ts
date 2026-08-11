import { createHash } from 'node:crypto'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Observations, ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { SANDBOX_GROUP, getOrNull, groupPath } from './resources.js'

interface SandboxRead {
  metadata?: { name?: string }
  spec?: {
    operatingMode?: string
    podTemplate?: { spec?: { containers?: Array<{ image?: string }> } }
  }
}

function imageOf(sandbox: SandboxRead): string | undefined {
  return sandbox.spec?.podTemplate?.spec?.containers?.[0]?.image
}

/**
 * Runtime-image rollout over bound Sandboxes. Suspended instances get a
 * conditioned image patch. Running instances are only reported pending: they
 * converge when they naturally sleep (the daemon suspends idle sandboxes) and
 * the next pass patches them. The drain-requested handshake — producer AND
 * daemon-side consumer — lands together with the daemon milestone, so no
 * annotation is written that nothing consumes yet.
 */
export async function reconcileRollout(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  if (!obs.namespaceReady || input.spec.suspend) return
  const ns = input.spec.targetNamespace
  const target = input.spec.runtime.image
  const rolloutId = createHash('sha256').update(target).digest('hex').slice(0, 8)
  const list = await getOrNull<{ items?: SandboxRead[] }>(ctx.http, groupPath(SANDBOX_GROUP, ns, 'sandboxes'))
  const pending: string[] = []
  for (const sandbox of list?.items ?? []) {
    const name = sandbox.metadata?.name
    if (!name) continue
    const image = imageOf(sandbox)
    // Warm-pool sandboxes without a pod template image inherit it from the template rollout.
    if (!image || image === target) continue
    pending.push(name)
    if (sandbox.spec?.operatingMode !== 'Suspended') continue
    // Conditioned: the test op makes a concurrent wake-up reject the image swap.
    try {
      await ctx.http.json({
        method: 'PATCH',
        path: groupPath(SANDBOX_GROUP, ns, 'sandboxes', name),
        contentType: 'application/json-patch+json',
        body: [
          { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
          { op: 'replace', path: '/spec/podTemplate/spec/containers/0/image', value: target }
        ]
      })
    } catch (error) {
      // A failed test op or a lost race means the mode moved — the next pass re-decides.
      if (!(error instanceof K8sApiError && (error.isUnprocessable || error.isConflict))) throw error
    }
  }
  // TODO(operator): drain timeouts move stuck instances from pending to failed.
  obs.rollout = pending.length > 0 ? { rolloutId, targetImage: target, pending: pending.sort(), failed: [] } : undefined
}
