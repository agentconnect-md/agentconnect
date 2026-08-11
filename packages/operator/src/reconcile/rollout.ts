import { createHash } from 'node:crypto'
import { systemClock } from '@agentconnect.md/connection'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import { DRAIN_REQUESTED_ANNOTATION, DRAIN_REQUESTED_AT_ANNOTATION } from '../crd/types.js'
import type { Observations, ReconcileContext } from './context.js'
import type { EnvelopeInputs } from './envelope.js'
import { SANDBOX_GROUP, getOrNull, groupPath } from './resources.js'

/** How long a Running instance may sit on a drain request before the rollout gives up on it.
 *  Comfortably past the daemon's own idle host reclaim (15 min by default), which is what makes
 *  a quiet instance drain at all — an instance still up after twice that is not going quiet. */
export const DRAIN_TIMEOUT_MS = 30 * 60_000

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

// A PATCH must name its patch type — the API server answers `application/json` with 415 — so the
// annotation writes take the merge-patch default and the conditioned image swap names JSON Patch.
async function patchSandbox(
  ctx: ReconcileContext,
  ns: string,
  name: string,
  body: unknown,
  contentType = 'application/merge-patch+json'
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
 * Runtime-image rollout over bound Sandboxes: Suspended instances get a conditioned image patch,
 * Running instances are asked to drain through the annotation handshake — never a forced suspend,
 * which would kill a live turn. The daemon holds a drained instance down and suspends it once its
 * work ends, so the next pass swaps the image. An instance still Running {@link DRAIN_TIMEOUT_MS}
 * after its request is reported `failed`: it stays listed and nothing is re-requested for this
 * target, because a drain that has not landed in half an hour will not land by being asked again.
 */
export async function reconcileRollout(ctx: ReconcileContext, input: EnvelopeInputs, obs: Observations): Promise<void> {
  if (!obs.namespaceReady || input.spec.suspend) return
  const ns = input.spec.targetNamespace
  const target = input.spec.runtime.image
  const rolloutId = createHash('sha256').update(target).digest('hex').slice(0, 8)
  const now = (ctx.clock ?? systemClock).now()
  const list = await getOrNull<{ items?: SandboxRead[] }>(ctx.http, groupPath(SANDBOX_GROUP, ns, 'sandboxes'))
  const pending: string[] = []
  const failed: string[] = []
  for (const sandbox of list?.items ?? []) {
    const name = sandbox.metadata?.name
    if (!name) continue
    const annotations = sandbox.metadata?.annotations ?? {}
    const image = imageOf(sandbox)
    // Warm-pool sandboxes without a pod template image inherit it from the template rollout.
    if (!image || image === target) {
      // The handshake is over the moment the instance runs the target; a left-over request would
      // keep the daemon refusing to wake it.
      if (annotations[DRAIN_REQUESTED_ANNOTATION]) {
        await patchSandbox(ctx, ns, name, {
          metadata: { annotations: { [DRAIN_REQUESTED_ANNOTATION]: null, [DRAIN_REQUESTED_AT_ANNOTATION]: null } }
        })
      }
      continue
    }
    if (sandbox.spec?.operatingMode === 'Suspended') {
      pending.push(name)
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
    const requestedAt = Date.parse(annotations[DRAIN_REQUESTED_AT_ANNOTATION] ?? '')
    // A request for another target, or one whose time is missing or unreadable (an older operator,
    // a hand-edited object), starts the deadline now rather than expiring against a time nobody wrote.
    if (annotations[DRAIN_REQUESTED_ANNOTATION] !== want || !Number.isFinite(requestedAt)) {
      await patchSandbox(ctx, ns, name, {
        metadata: {
          annotations: {
            [DRAIN_REQUESTED_ANNOTATION]: want,
            [DRAIN_REQUESTED_AT_ANNOTATION]: new Date(now).toISOString()
          }
        }
      })
      pending.push(name)
      continue
    }
    if (now - requestedAt >= DRAIN_TIMEOUT_MS) failed.push(name)
    else pending.push(name)
  }
  obs.rollout =
    pending.length + failed.length > 0
      ? { rolloutId, targetImage: target, pending: pending.sort(), failed: failed.sort() }
      : undefined
}
