import { TunnelProxy, type TunnelProxyDeps } from '../shim/tunnel-proxy.js'
import type { TunnelName } from '../shim/tunnel.js'

/** What a bound channel has to offer this binder: the proxy's own session surface plus the
 *  generation that says which pod incarnation it belongs to. `ShimSession` satisfies it. */
export type TunnelSession = TunnelProxyDeps['session'] & { generation: number }

export interface TunnelBinderDeps {
  /**
   * Which daemon-side sockets an agent's sandbox needs a tunnel to, and where each one lives.
   *
   * Both halves are the DAEMON's to answer: only it knows that this agent authenticates git
   * through a GitHub App, and only it knows the path its own server listens on. The binder holds
   * the mechanism and no policy — omit either and no tunnel is opened.
   */
  tunnelsFor?: (agentId: string) => TunnelName[]
  tunnelSocketPath?: (tunnel: TunnelName) => string | undefined
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/**
 * One TunnelProxy per agent, replaced when a NEW launch binds: its streams belong to a pod, and a
 * proxy kept across incarnations would answer connections for a sandbox that no longer exists.
 */
export class TunnelBinder {
  private readonly proxies = new Map<string, { generation: number; proxy: TunnelProxy }>()

  constructor(private readonly deps: TunnelBinderDeps) {}

  /** Open every tunnel this agent wants on the session that just bound. */
  async ensure(agentId: string, session: TunnelSession): Promise<void> {
    const wanted = this.deps.tunnelsFor?.(agentId) ?? []
    const socketPathFor = this.deps.tunnelSocketPath
    if (wanted.length === 0 || !socketPathFor) return
    const existing = this.proxies.get(agentId)
    // Stopped counts as gone: a proxy whose session was lost can never serve again, and reusing
    // one would leave the sandbox with a socket whose daemon end refuses every connection.
    if (existing && (existing.generation !== session.generation || existing.proxy.isStopped())) {
      existing.proxy.stop(`superseded by generation ${session.generation}`)
      this.proxies.delete(agentId)
    }
    let entry = this.proxies.get(agentId)
    if (!entry) {
      entry = {
        generation: session.generation,
        proxy: new TunnelProxy({ session, socketPathFor, log: this.deps.log })
      }
      this.proxies.set(agentId, entry)
    }
    // Sequential rather than concurrent: this is on the launch path, the list has two members at
    // most, and one failing tunnel must not lose the report of the other.
    for (const tunnel of wanted) {
      await entry.proxy.ensure(tunnel).catch((err: unknown) => {
        this.deps.log.warn(`k8s: agent ${agentId} has no ${tunnel} tunnel — ${(err as Error).message}`)
      })
    }
  }

  /** Drop the agent's proxy: this member no longer serves the launch its streams belong to. */
  release(agentId: string, reason: string): void {
    this.proxies.get(agentId)?.proxy.stop(reason)
    this.proxies.delete(agentId)
  }

  releaseAll(reason: string): void {
    for (const { proxy } of this.proxies.values()) proxy.stop(reason)
    this.proxies.clear()
  }
}
