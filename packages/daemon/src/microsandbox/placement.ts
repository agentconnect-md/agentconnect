// Which VM a local microsandbox launch runs in (session-executors.md §11 step 3), named as every existing VM, disk and binding already is.
import { join, relative, sep } from 'node:path'
import { agentHostKey, hostEnvironmentId, type HostKey } from '../acp/host-key.js'
import type { EnvironmentDescriptor } from '../execution/strategies.js'

export interface LocalMicrosandboxPlacement {
  /** `<agentId>/session-…`, `<agentId>/agent` or `<agentId>/<host key>`: never `executor/…`, which is the hosted space. */
  id: string
  /** A session-isolated session's own directory, its VM's one writable session root. */
  trustedSessionDir?: string
  /** The HOME a retained legacy session keeps: the agent's own. */
  homeKey?: HostKey
}

/** A session-isolated session gets its own VM; a retained legacy session the agent's VM and HOME; anything else the VM of its host key. */
export function localMicrosandboxPlacement(input: {
  agentId: string
  agentDir: string
  cwd: string
  hostKey?: HostKey
  /** The host key is a legacy session this machine keeps on the agent's VM. */
  legacy?: boolean
}): LocalMicrosandboxPlacement {
  const parts = relative(input.agentDir, input.cwd).split(sep)
  if (parts[0] === 'sessions' && /^session-[a-f0-9]{24}$/.test(parts[1] ?? '')) {
    return { id: `${input.agentId}/${parts[1]}`, trustedSessionDir: join(input.agentDir, 'sessions', parts[1]!) }
  }
  // A legacy session keeps its VM and HOME even when its MCP scope requires a separate ACP process.
  if (input.hostKey && input.legacy)
    return { id: hostEnvironmentId(input.agentId, undefined), homeKey: agentHostKey(input.agentId) }
  return { id: hostEnvironmentId(input.agentId, input.hostKey) }
}

/** A local launch's environment as a strategy launcher takes it: the placement's id over what the launch composition mounts, never `hosted`; the VM's spec hashes every field, so nothing is added. */
export function localMicrosandboxEnvironment(
  id: string,
  prepared: Omit<EnvironmentDescriptor, 'id' | 'hosted'>
): EnvironmentDescriptor {
  return { id, ...prepared }
}
