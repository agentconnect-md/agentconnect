import { ShimCapability } from '../shim/protocol.js'
import type { Sandbox } from './sandbox-api.js'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'

/** Where agent-sandbox records the pod a Sandbox is backed by — the only pod reference the daemon can read, since `SandboxStatus` carries none and the Pod API is outside its Role. */
export const SANDBOX_POD_NAME_ANNOTATION = 'agents.x-k8s.io/pod-name'

/** The pod backing this Sandbox: the adopted warm-pool pod, or the Sandbox's own name. */
export function resolvePodName(sandbox: Sandbox): string | undefined {
  const adopted = sandbox.metadata?.annotations?.[SANDBOX_POD_NAME_ANNOTATION]
  return adopted && adopted.length > 0 ? adopted : sandbox.metadata?.name
}

/** The first routable address reported for the pod backing this Sandbox. */
export function resolvePodIp(sandbox: Sandbox): string | undefined {
  for (const entry of sandbox.status?.podIPs ?? []) {
    const ip = typeof entry === 'string' ? entry : entry.ip
    if (ip?.trim()) return ip.trim()
  }
  return undefined
}

/** Capabilities a runtime launch receives. Narrow by construction: a launch gets exactly
 *  what the channels it uses require, so a future capability is an explicit decision. */
export const RUNTIME_GRANTS: ShimCapability[] = [
  'acp',
  'materialize',
  'exec',
  'read',
  'tunnel',
  'automerge',
  'skills',
  'skills-wide'
]

/** A probe sandbox asks the image what it provides and then RUNS those runtimes to read the
 *  models they advertise, so it gets those two channels and nothing else — no workspace, no
 *  tunnel, no materialized secret. Granting `probe` to every launch instead would hand each
 *  agent's runtime an authority it never exercises — which the direct-connect grant test catches. */
export const PROBE_GRANTS: ShimCapability[] = ['probe', 'acp']

/** A launch stage that ran out of time. Typed, because a missed target and a broken cluster are
 *  different operational stories and telling them apart by error text is a liability. */
export class LaunchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchTimeoutError'
  }
}

/**
 * The runtime image the pool's template pins, resolved from the cluster rather than from any
 * daemon-side configuration: it is what a sandbox will actually run, and it is the same answer for
 * every member at a given moment. That makes it the honest identity for anything that describes
 * the image rather than the member — the pool-wide runtime probe keys its published result on it,
 * so a template bump is a different key and cannot be served a previous image's answer.
 */
export async function poolRuntimeImage(
  api: {
    getWarmPool: (name: string) => Promise<{ spec?: { sandboxTemplateRef?: { name?: string } } }>
    getSandboxTemplate: (name: string) => Promise<{
      spec?: { podTemplate?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } }
    }>
  },
  warmPoolName: string
): Promise<string> {
  const pool = await api.getWarmPool(warmPoolName)
  const templateName = pool.spec?.sandboxTemplateRef?.name
  // Absent and non-canonical are separate reports: one is a template that was never wired up, the
  // other a value someone padded, and an operator chases them differently.
  if (!templateName?.trim()) throw new Error(`sandbox warm pool ${warmPoolName} has no sandboxTemplateRef.name`)
  if (templateName.trim() !== templateName) {
    throw new Error(`sandbox warm pool ${warmPoolName} has invalid sandboxTemplateRef.name`)
  }
  const template = await api.getSandboxTemplate(templateName)
  const containers = (template.spec?.podTemplate?.spec?.containers ?? []).filter((one) => one.name === 'runtime')
  if (containers.length > 1) throw new Error(`sandbox template ${templateName} has multiple runtime containers`)
  const image = containers[0]?.image
  if (!image?.trim()) throw new Error(`sandbox template ${templateName} runtime container has no image`)
  if (image.trim() !== image) throw new Error(`sandbox template ${templateName} runtime container has invalid image`)
  return image
}
