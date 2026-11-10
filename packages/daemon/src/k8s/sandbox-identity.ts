import type { ShimCapability } from '../shim/protocol.js'
import type { ResumeImage, Sandbox } from './sandbox-api.js'
import { sandboxSubjectAgentId, sandboxSubjectSessionLeaf } from '../remote/sandbox-subject.js'

// The subject helpers carry nothing Kubernetes-specific, so they live beside the shim dial layer and are re-exported here.
export * from '../remote/sandbox-subject.js'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'
/** The session leaf of a per-session pod, beside — never inside — the agent label the reconciler validates as a UUID. */
export const AC_LABEL_SESSION = 'agentconnect.md/session'
// When a claim was last admitted, RFC 3339, on the CLAIM's own metadata and never in its spec or its pod's — warm-pool adoption reads the spec, and this is bookkeeping between admission and the orphan sweep (k8s-daemon-pool.md §4).
export const AC_ANNOTATION_ADMITTED = 'agentconnect.md/last-admitted-at'

// Kept under 63 characters so the Sandbox and Service the controller names after the claim stay DNS labels: the leaf's hash is truncated in the NAME only; the label carries the whole leaf.
export function sandboxClaimName(subject: string): string {
  const leaf = sandboxSubjectSessionLeaf(subject)
  const base = `agent-${sandboxSubjectAgentId(subject)}`
  return leaf === undefined ? base : `${base}-${leaf.replace(/^session-/, '').slice(0, 16)}`
}

/** When these annotations say the claim was last admitted, epoch ms, or NaN when they do not say. */
export function claimAdmittedAt(annotations: Record<string, string> | undefined): number {
  return Date.parse(annotations?.[AC_ANNOTATION_ADMITTED] ?? '')
}

/** The pod labels a subject's claim carries: the tenant, the agent, and — for a session pod — its leaf. */
export function sandboxPodLabels(orgId: string, subject: string): Record<string, string> {
  const leaf = sandboxSubjectSessionLeaf(subject)
  return {
    [AC_LABEL_ORG]: orgId,
    [AC_LABEL_AGENT]: sandboxSubjectAgentId(subject),
    ...(leaf === undefined ? {} : { [AC_LABEL_SESSION]: leaf })
  }
}

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
  'skills-wide',
  'skills-receipts',
  'skills-git',
  'skills-git-writeback',
  'skills-git-gitlab',
  'bundle',
  'transfer'
]

/** A probe sandbox asks the image what it provides and then RUNS those runtimes to read the
 *  models they advertise, so it gets those two channels and nothing else — no workspace, no
 *  tunnel, no materialized secret. Granting `probe` to every launch instead would hand each
 *  agent's runtime an authority it never exercises — which the direct-connect grant test catches. */
export const PROBE_GRANTS: ShimCapability[] = ['probe', 'acp']

export { LaunchTimeoutError } from '../remote/shim-endpoint.js'

type PoolTemplateApi = {
  getWarmPool: (name: string) => Promise<{ spec?: { sandboxTemplateRef?: { name?: string } } }>
  getSandboxTemplate: (name: string) => Promise<{
    spec?: { podTemplate?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } }
  }>
}

/** The image the pool's template pins for its `runtime` container: read from the cluster, so every member agrees, and a template bump is a new probe key. */
export async function poolRuntimeImage(api: PoolTemplateApi, warmPoolName: string): Promise<string> {
  return await poolContainerImage(api, warmPoolName, 'runtime')
}

/** The image the pool's template pins for the named container. */
export async function poolContainerImage(
  api: PoolTemplateApi,
  warmPoolName: string,
  containerName: string
): Promise<string> {
  const pool = await api.getWarmPool(warmPoolName)
  const templateName = pool.spec?.sandboxTemplateRef?.name
  // Absent and padded are separate reports: an operator chases a never-wired template and a padded value differently.
  if (!templateName?.trim()) throw new Error(`sandbox warm pool ${warmPoolName} has no sandboxTemplateRef.name`)
  if (templateName.trim() !== templateName) {
    throw new Error(`sandbox warm pool ${warmPoolName} has invalid sandboxTemplateRef.name`)
  }
  const template = await api.getSandboxTemplate(templateName)
  const containers = (template.spec?.podTemplate?.spec?.containers ?? []).filter((one) => one.name === containerName)
  if (containers.length > 1)
    throw new Error(`sandbox template ${templateName} has multiple ${containerName} containers`)
  const image = containers[0]?.image
  if (!image?.trim()) throw new Error(`sandbox template ${templateName} ${containerName} container has no image`)
  if (image.trim() !== image) {
    throw new Error(`sandbox template ${templateName} ${containerName} container has invalid image`)
  }
  return image
}

/** Where the named container sits in this Sandbox's own pod template and the image it runs now. */
export function sandboxContainerImage(
  sandboxName: string,
  sandbox: Sandbox,
  containerName: string
): Omit<ResumeImage, 'targetImage'> {
  const containers = sandbox.spec?.podTemplate?.spec?.containers ?? []
  const indexes = containers.flatMap((container, index) => (container.name === containerName ? [index] : []))
  if (indexes.length === 0) throw new Error(`sandbox ${sandboxName} has no ${containerName} container`)
  if (indexes.length > 1) throw new Error(`sandbox ${sandboxName} has multiple ${containerName} containers`)
  const containerIndex = indexes[0]!
  const observedImage = containers[containerIndex]?.image
  if (!observedImage?.trim()) throw new Error(`sandbox ${sandboxName} ${containerName} container has no image`)
  if (observedImage.trim() !== observedImage) {
    throw new Error(`sandbox ${sandboxName} ${containerName} container has invalid image`)
  }
  return { containerIndex, observedName: containerName, observedImage }
}
