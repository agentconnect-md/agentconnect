// Which daemon-side socket each shim tunnel reaches, named per tunnel so a new tunnel cannot fall through to another's server.
import type { TunnelName } from '../shim/tunnel.js'

export interface DaemonTunnelSockets {
  gitcred: string
  mcp: string
  /** The agent's own credential-proxy tunnel socket, or undefined when the proxy serves that agent none. */
  codehost: (agentId: string) => string | undefined
}

/** The daemon socket a tunnel's streams dial for an agent; undefined for a tunnel this daemon does not serve it. */
export function daemonTunnelSocketPath(
  tunnel: TunnelName,
  agentId: string,
  sockets: DaemonTunnelSockets
): string | undefined {
  switch (tunnel) {
    case 'gitcred':
      return sockets.gitcred
    case 'mcp':
      return sockets.mcp
    case 'codehost':
      return sockets.codehost(agentId)
    default: {
      // A name added to the schema fails to compile here instead of dialling a plausible socket.
      const unhandled: never = tunnel
      void unhandled
      return undefined
    }
  }
}
