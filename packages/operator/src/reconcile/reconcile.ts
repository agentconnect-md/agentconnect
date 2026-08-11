import { K8sApiError } from '@agentconnect.md/k8s-client'
import { AgentConnectOrgSpecSchema, FINALIZER, type AgentConnectOrg } from '../crd/types.js'
import { newObservations, type ReconcileContext } from './context.js'
import { reconcileEnvelope, type EnvelopeInputs } from './envelope.js'
import { daemonPodsGone, reconcileDeletion, suspendAllSandboxes } from './finalizer.js'
import { renderGatewayPolicies } from './gateway-limits.js'
import { reconcileRollout } from './rollout.js'
import { observeWorkloads, writeStatus } from './status.js'

/** One level-triggered pass for one org: read live state, dispatch, publish status. */
export async function reconcile(ctx: ReconcileContext, name: string): Promise<void> {
  let org: AgentConnectOrg
  try {
    org = await ctx.orgApi.get(name)
  } catch (error) {
    if (error instanceof K8sApiError && error.isNotFound) return
    throw error
  }
  if (org.metadata?.deletionTimestamp) {
    await reconcileDeletion(ctx, org)
    return
  }
  if (!(org.metadata?.finalizers ?? []).includes(FINALIZER)) {
    org = await ctx.orgApi.updateFinalizer(name, FINALIZER, 'add')
  }
  const obs = newObservations()
  // The zod parse supplies CRD defaults and rejects a spec the API server should not have admitted.
  const parsed = AgentConnectOrgSpecSchema.safeParse(org.spec)
  if (!parsed.success) {
    obs.degraded = { reason: 'InvalidSpec', message: parsed.error.issues.map((issue) => issue.message).join('; ') }
    await writeStatus(ctx, org, obs)
    return
  }
  const input: EnvelopeInputs = { orgName: name, spec: parsed.data }
  await reconcileEnvelope(ctx, input, obs)
  // suspend also quiesces bound Sandboxes — but only after the daemon pod finished draining,
  // since suspension deletes the runtime pod a mid-drain daemon may still be using. The
  // org-labeled pod deletion event re-enqueues this CR the moment the daemon is gone.
  if (input.spec.suspend && obs.namespaceReady) {
    if (await daemonPodsGone(ctx, input.spec.targetNamespace)) {
      await suspendAllSandboxes(ctx, input.spec.targetNamespace)
    } else {
      obs.progressing = true
    }
  }
  await reconcileRollout(ctx, input, obs)
  await renderGatewayPolicies(ctx, input, obs)
  if (obs.namespaceReady) await observeWorkloads(ctx, input, obs)
  await writeStatus(ctx, org, obs)
}
