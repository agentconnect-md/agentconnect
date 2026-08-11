import { createHash } from 'node:crypto'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { DRAIN_REQUESTED_ANNOTATION } from '../crd/types.js'
import type { Observations, ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { SANDBOX_GROUP, getOrNull, groupPath } from './resources.js'

interface SandboxRead {
  metadata?: { name?: string; annotations?: Record<string, string> }
  spec?: {
    operatingMode?: string
    podTemplate?: { spec?: { containers?: Array<{ image?: string }> } }
  }
}

function imageOf(sandbox: SandboxRead): string | undefined {
  return sandbox.spec?.podTemplate?.spec?.containers?.[0]?.image
}

async function patchSandbox(
  ctx: ReconcileContext,
  ns: string,
  name: string,
  body: unknown,
  contentType?: string
): Promise<boolean> {
  try {
    await ctx.http.json({ method: 'PATCH', path: groupPath(SANDBOX_GROUP, ns, 'sandboxes', name), body, contentType })
    return true
  } catch (error) {
    // A failed test op or a lost race means the mode moved — the next pass re-decides.
    if (error instanceof K8sApiError && (error.isUnprocessable || error.isConflict)) return false
    throw error
  }
}

/**
 * Runtime-image rollout over bound Sandboxes: Suspended instances get a
 * conditioned image patch, Running instances go through the drain-requested
 * annotation handshake — never a forced suspend.
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
    if (!image || image === target) {
      if (sandbox.metadata?.annotations?.[DRAIN_REQUESTED_ANNOTATION]) {
        await patchSandbox(ctx, ns, name, { metadata: { annotations: { [DRAIN_REQUESTED_ANNOTATION]: null } } })
      }
      continue
    }
    pending.push(name)
    if (sandbox.spec?.operatingMode === 'Suspended') {
      // Conditioned: the test op makes a concurrent wake-up reject the image swap.
      await patchSandbox(
        ctx,
        ns,
        name,
        [
          { op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
          { op: 'replace', path: '/spec/podTemplate/spec/containers/0/image', value: target }
        ],
        'application/json-patch+json'
      )
      continue
    }
    const want = `${rolloutId}/${target}`
    if (sandbox.metadata?.annotations?.[DRAIN_REQUESTED_ANNOTATION] !== want) {
      await patchSandbox(ctx, ns, name, { metadata: { annotations: { [DRAIN_REQUESTED_ANNOTATION]: want } } })
    }
  }
  // TODO(operator): drain timeouts move stuck instances from pending to failed.
  obs.rollout = pending.length > 0 ? { rolloutId, targetImage: target, pending: pending.sort(), failed: [] } : undefined
}
