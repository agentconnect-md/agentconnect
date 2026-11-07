// Which daemon-side socket each shim tunnel reaches, named per tunnel so a new tunnel cannot fall through to another's server.
import type { TunnelName } from '../shim/tunnel.js'

export interface DaemonTunnelSockets {
  agent: string
  mcp: string
  /** The agent's own credential-proxy tunnel socket, or undefined when the proxy serves that agent none. */
  codehost: (agentId: string) => string | undefined
  /** The agent's own credential-proxy provider socket, or undefined when the proxy serves that agent no provider slot. */
  provider: (agentId: string) => string | undefined
}

/** The daemon socket a tunnel's streams dial for an agent; undefined for a tunnel this daemon does not serve it. */
export function daemonTunnelSocketPath(
  tunnel: TunnelName,
  agentId: string,
  sockets: DaemonTunnelSockets
): string | undefined {
  switch (tunnel) {
    case 'agent':
      return sockets.agent
    case 'mcp':
      return sockets.mcp
    case 'codehost':
      return sockets.codehost(agentId)
    case 'provider':
      return sockets.provider(agentId)
    default: {
      // A name added to the schema fails to compile here instead of dialling a plausible socket.
      const unhandled: never = tunnel
      void unhandled
      return undefined
    }
  }
}
