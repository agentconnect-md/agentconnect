import type { ShimCapability } from '../shim/protocol.js'
import type { Sandbox } from './sandbox-api.js'
import { hostKeyAgentId, hostKeyDirName, hostKeySessionKey, type HostKey } from '../acp/host-key.js'
import { SESSIONS_DIR } from '../workspace/session-layout.js'

/** Label domain the claim controller must be configured to allow. */
export const AC_LABEL_ORG = 'agentconnect.md/org'
export const AC_LABEL_AGENT = 'agentconnect.md/agent'
/** The session leaf of a per-session pod, beside — never inside — the agent label the reconciler validates as a UUID. */
export const AC_LABEL_SESSION = 'agentconnect.md/session'
// When a claim was last admitted, RFC 3339, on the CLAIM's own metadata and never in its spec or its pod's — warm-pool adoption reads the spec, and this is bookkeeping between admission and the orphan sweep (k8s-daemon-pool.md §4).
export const AC_ANNOTATION_ADMITTED = 'agentconnect.md/last-admitted-at'

// What a Sandbox is claimed for: the agent's shared pod, or one confined session's own (git-workspace-model §11). A plain agent id IS the agent pod's subject, so the alias is deliberate: every agent-keyed caller is already a subject-keyed one.
export type SandboxSubject = string

// A slash never appears in an agent id or a `session-<hex>` leaf, and unlike the host key's NUL it survives a Postgres TEXT column and a log line.
const SESSION_SUBJECT_SEPARATOR = '/'

/** The subject of the agent's shared pod — the agent id itself, so every agent-keyed caller is already a subject-keyed one. */
export function agentSandboxSubject(agentId: string): SandboxSubject {
  return agentId
}

/** The subject of one confined session's pod, by the leaf its host key names (`session-<24 hex>`). */
export function sessionSandboxSubject(agentId: string, leaf: string): SandboxSubject {
  return `${agentId}${SESSION_SUBJECT_SEPARATOR}${leaf}`
}

/** The pod a host launches into: the agent's for its shared host, the session's own for a session-bound host. */
export function sandboxSubjectFor(key: HostKey): SandboxSubject {
  const agentId = hostKeyAgentId(key)
  return hostKeySessionKey(key) === undefined
    ? agentSandboxSubject(agentId)
    : sessionSandboxSubject(agentId, hostKeyDirName(key))
}

export function sandboxSubjectAgentId(subject: string): string {
  const at = subject.indexOf(SESSION_SUBJECT_SEPARATOR)
  return at < 0 ? subject : subject.slice(0, at)
}

/** The session leaf of a per-session pod's subject, or undefined for the agent's shared pod. */
export function sandboxSubjectSessionLeaf(subject: string): string | undefined {
  const at = subject.indexOf(SESSION_SUBJECT_SEPARATOR)
  return at < 0 ? undefined : subject.slice(at + 1)
}

// Kept under 63 characters so the Sandbox and Service the controller names after the claim stay DNS labels: the leaf's hash is truncated in the NAME only; the label carries the whole leaf.
export function sandboxClaimName(subject: string): string {
  const leaf = sandboxSubjectSessionLeaf(subject)
  const base = `agent-${sandboxSubjectAgentId(subject)}`
  return leaf === undefined ? base : `${base}-${leaf.replace(/^session-/, '').slice(0, 16)}`
}

// The pod a workspace path lives on, read off the PATH: `<mount>/sessions/<leaf>` names the session pod whether or not this member holds its launch, everything else is the agent's own (§11).
export function sandboxSubjectForPath(agentId: string, path: string | undefined, mount: string): SandboxSubject {
  const base = mount.replace(/\/+$/, '')
  if (path !== undefined && path.startsWith(`${base}/`)) {
    const [dir, leaf] = path.slice(base.length + 1).split('/')
    if (dir === SESSIONS_DIR && leaf?.startsWith('session-')) return sessionSandboxSubject(agentId, leaf)
  }
  return agentSandboxSubject(agentId)
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
