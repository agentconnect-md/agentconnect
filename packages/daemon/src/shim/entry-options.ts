import {
  DEFAULT_SHIM_LISTEN_PORT,
  DEFAULT_SHIM_WORKSPACE_ROOT,
  SHIM_COMPLETE_ENV_FLAG,
  SHIM_HELPER_ROOT_ENV,
  SHIM_LISTEN_PORT_ENV,
  SHIM_LISTEN_SOCKET_ENV,
  SHIM_PARENT_FD_ENV,
  SHIM_RUNTIME_MARK_ENV,
  SHIM_RUNTIME_ROOT_ENV,
  SHIM_WORKSPACE_ROOT_ENV
} from './protocol.js'
import { shimPaths, type ShimPaths } from './sandbox-paths.js'

export interface ShimEntryOptions {
  /** Where to accept the daemon: a unix socket path when the starter named one, else a TCP port. */
  listen: { socketPath: string } | { port: number }
  workspaceRoot: string
  paths: ShimPaths
  /** Explicit, never implied by how the identity arrived: a holder on another machine describes a different machine. */
  completeEnv: boolean
  /** Set by a host launcher only; pods and VMs have a teardown of their own and get none. */
  runtimeMark?: string
  /** Host mode only: the descriptor whose end-of-file means the daemon that started this shim is gone. */
  parentFd?: number
}

/** What the entrypoint reads from its environment; unset keeps the image's fixed layout, and `||` keeps '' from rooting paths at '/'. */
export function shimEntryOptions(env: Record<string, string | undefined>): ShimEntryOptions {
  const socketPath = env[SHIM_LISTEN_SOCKET_ENV]?.trim()
  const port = Number(env[SHIM_LISTEN_PORT_ENV] ?? DEFAULT_SHIM_LISTEN_PORT)
  if (!socketPath && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`${SHIM_LISTEN_PORT_ENV} is not a valid port`)
  }
  const parentFd = Number(env[SHIM_PARENT_FD_ENV])
  return {
    // A pod or a VM ends with its sandbox, so only a shim on a host socket watches for its daemon.
    ...(socketPath && Number.isInteger(parentFd) && parentFd > 2 ? { parentFd } : {}),
    listen: socketPath ? { socketPath } : { port },
    workspaceRoot: env[SHIM_WORKSPACE_ROOT_ENV] ?? DEFAULT_SHIM_WORKSPACE_ROOT,
    paths: shimPaths(env[SHIM_RUNTIME_ROOT_ENV]?.trim() || undefined, env[SHIM_HELPER_ROOT_ENV]?.trim() || undefined),
    completeEnv: env[SHIM_COMPLETE_ENV_FLAG] === '1',
    ...(env[SHIM_RUNTIME_MARK_ENV] ? { runtimeMark: env[SHIM_RUNTIME_MARK_ENV] } : {})
  }
}
