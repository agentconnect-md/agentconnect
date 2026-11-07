import { TunnelProxy, type TunnelProxyDeps } from '../shim/tunnel-proxy.js'
import type { TunnelListening, TunnelListenOptions, TunnelName } from '../shim/tunnel.js'
import { sandboxSubjectAgentId } from './sandbox-subject.js'

/** What a bound channel has to offer this binder: the proxy's own session surface plus the
 *  generation that says which pod incarnation it belongs to. `ShimSession` satisfies it. */
export type TunnelSession = TunnelProxyDeps['session'] & { generation: number }

export interface TunnelBinderDeps {
  /** Which daemon-side sockets a subject's sandbox needs, by its agent and the subject itself; the daemon's policy, omitted means none. */
  tunnelsFor?: (agentId: string, subject: string) => TunnelName[]
  /** Where this daemon serves a tunnel for an agent: one socket per daemon for the helpers, the agent's own for `codehost`. */
  tunnelSocketPath?: (tunnel: TunnelName, agentId: string) => string | undefined
  /** The line that tags a subject's connection to a daemon socket with that subject (the agent channel's pod window binding). */
  tunnelGreeting?: (subject: string, tunnel: TunnelName) => Buffer | undefined
  /** What a subject's `listen` carries beside the name (`codehost`'s routes and CA). */
  tunnelListenOptions?: (agentId: string, tunnel: TunnelName) => TunnelListenOptions | undefined
  log: { info: (m: string) => void; warn: (m: string) => void; debug?: (m: string) => void }
}

/**
 * One TunnelProxy per subject (agent pod or session pod), replaced when a NEW launch binds: its streams
 * belong to a pod, and a proxy kept across incarnations would answer connections for a sandbox that no
 * longer exists.
 */
export class TunnelBinder {
  private readonly proxies = new Map<string, { generation: number; proxy: TunnelProxy }>()

  constructor(private readonly deps: TunnelBinderDeps) {}

  /** Open every tunnel this subject's agent wants on the session that just bound. */
  async ensure(subject: string, session: TunnelSession): Promise<void> {
    const agentId = sandboxSubjectAgentId(subject)
    const wanted = this.deps.tunnelsFor?.(agentId, subject) ?? []
    const socketPathFor = this.deps.tunnelSocketPath
    if (wanted.length === 0 || !socketPathFor) return
    const existing = this.proxies.get(subject)
    // Stopped counts as gone: a proxy whose session was lost can never serve again, and reusing
    // one would leave the sandbox with a socket whose daemon end refuses every connection.
    if (existing && (existing.generation !== session.generation || existing.proxy.isStopped())) {
      existing.proxy.stop(`superseded by generation ${session.generation}`)
      this.proxies.delete(subject)
    }
    let entry = this.proxies.get(subject)
    if (!entry) {
      entry = {
        generation: session.generation,
        proxy: new TunnelProxy({
          session,
          socketPathFor: (tunnel) => socketPathFor(tunnel, agentId),
          greeting: (tunnel) => this.deps.tunnelGreeting?.(subject, tunnel),
          listenOptions: (tunnel) => this.deps.tunnelListenOptions?.(agentId, tunnel),
          log: this.deps.log
        })
      }
      this.proxies.set(subject, entry)
    }
    // Sequential: the list is short, and one failing tunnel must not lose the report of the others.
    for (const tunnel of wanted) {
      await entry.proxy.ensure(tunnel).catch((err: unknown) => {
        this.deps.log.warn(`k8s: sandbox ${subject} has no ${tunnel} tunnel — ${(err as Error).message}`)
      })
    }
  }

  /** Whether the subject's bound pod serves `tunnel`: a pod bound by an older daemon may lack `agent` (source-cache.md §8). */
  serves(subject: string, tunnel: TunnelName): boolean {
    return this.proxies.get(subject)?.proxy.serves(tunnel) === true
  }

  /** Where the subject's bound sandbox serves `tunnel`, as its shim reported it. */
  listeningAt(subject: string, tunnel: TunnelName): TunnelListening | undefined {
    return this.proxies.get(subject)?.proxy.listeningAt(tunnel)
  }

  /** Drop the subject's proxy: this member no longer serves the launch its streams belong to. */
  release(subject: string, reason: string): void {
    this.proxies.get(subject)?.proxy.stop(reason)
    this.proxies.delete(subject)
  }

  releaseAll(reason: string): void {
    for (const { proxy } of this.proxies.values()) proxy.stop(reason)
    this.proxies.clear()
  }
}
