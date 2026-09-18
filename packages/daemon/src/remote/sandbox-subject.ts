import { hostKeyAgentId, hostKeyDirName, hostKeySessionKey, type HostKey } from '../acp/host-key.js'
import { SESSIONS_DIR } from '../workspace/session-layout.js'

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

// The pod a workspace path lives on, read off the PATH: `<mount>/sessions/<leaf>` names the session pod whether or not this member holds its launch, everything else is the agent's own (§11).
export function sandboxSubjectForPath(agentId: string, path: string | undefined, mount: string): SandboxSubject {
  const base = mount.replace(/\/+$/, '')
  if (path !== undefined && path.startsWith(`${base}/`)) {
    const [dir, leaf] = path.slice(base.length + 1).split('/')
    if (dir === SESSIONS_DIR && leaf?.startsWith('session-')) return sessionSandboxSubject(agentId, leaf)
  }
  return agentSandboxSubject(agentId)
}
