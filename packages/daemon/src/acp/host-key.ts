import { createHash } from 'node:crypto'

// The identity of one ACP host: the agent id alone for the agent's shared host, or the agent id
// with the logical session key for a host that serves exactly one session (git-workspace-model §11).
export type HostKey = string & { readonly __hostKey: unique symbol }

// NUL never appears in an agent id (a directory name or a cuid), so the first one splits the key.
const SESSION_SEPARATOR = String.fromCharCode(0)

/** The key of the host every session of the agent shares. */
export function agentHostKey(agentId: string): HostKey {
  return agentId as HostKey
}

/** The key of the host bound to one logical session (`sessionKey` from store/local-store.ts). */
export function sessionHostKey(agentId: string, sessionKey: string): HostKey {
  return `${agentId}${SESSION_SEPARATOR}${sessionKey}` as HostKey
}

export function hostKeyAgentId(key: HostKey): string {
  const at = key.indexOf(SESSION_SEPARATOR)
  return at < 0 ? key : key.slice(0, at)
}

/** The bound session's key, or undefined for the agent's shared host. */
export function hostKeySessionKey(key: HostKey): string | undefined {
  const at = key.indexOf(SESSION_SEPARATOR)
  return at < 0 ? undefined : key.slice(at + 1)
}

/** Leaf directory for daemon-owned per-host state under the agent dir; absent ⇒ the shared host. */
export function hostKeyDirName(key: HostKey | undefined): string {
  const sessionKey = key === undefined ? undefined : hostKeySessionKey(key)
  if (sessionKey === undefined) return 'agent'
  return `session-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`
}

/** Printable form for logs: the agent id, plus the session leaf for a session-bound host. */
export function hostKeyLabel(key: HostKey): string {
  const sessionKey = hostKeySessionKey(key)
  return sessionKey === undefined ? key : `${hostKeyAgentId(key)} (${hostKeyDirName(key)})`
}
