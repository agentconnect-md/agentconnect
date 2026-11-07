// Where an agent with a proxy-only provider's repositories may start a host (azure-devops-integration.md §6.1): only where the credential proxy carries its sessions and the daemon's own Git beside them, never without the credential.
import { codeHostCredentials } from '../codehost/credentials.js'

/** What decides whether the credential proxy carries one host of an agent. */
export interface ProxyOnlyReach {
  /** This daemon's credential proxy started. */
  proxyRunning: boolean
  /** The agent's spec gives it a managed code-host credential at all. */
  managedCredential: boolean
  /** A pool member, whose sessions and Git run in a pod. */
  cluster: boolean
  /** The host serves a session placed on another daemon's executor. */
  placedOnExecutor: boolean
  /** The strategy the host runs in on this machine. */
  strategy: string
  /** Every proxy-only provider of the agent has an instance the proxy serves; read last. */
  served: () => boolean
}

/** Strategies whose sessions and daemon Git both reach the proxy here: the host itself, and srt, whose route the daemon's Git takes with the placeholder. */
const REACHED_STRATEGIES: ReadonlySet<string> = new Set(['host', 'srt'])

function unreached(reach: ProxyOnlyReach): string | undefined {
  if (!reach.proxyRunning) return 'the credential proxy is not running on this daemon'
  if (!reach.managedCredential) return 'the agent holds no managed code-host credential'
  if (reach.cluster) return "a pool pod's own Git does not reach the proxy yet"
  if (reach.placedOnExecutor)
    return "a session placed on another daemon's executor does not reach it with that daemon's Git yet"
  if (!REACHED_STRATEGIES.has(reach.strategy)) return `the ${reach.strategy} strategy's own Git does not reach it yet`
  if (!reach.served()) return 'the proxy serves none of those repositories, whose routing the spec does not carry'
  return undefined
}

/** The refusal of a host for an agent with these proxy-only providers, `{provider}_requires_proxy: …`; undefined where the proxy carries it. */
export function proxyOnlyHostRefusal(providers: readonly string[], reach: ProxyOnlyReach): string | undefined {
  const [provider] = providers
  if (provider === undefined) return undefined
  const reason = unreached(reach)
  if (reason === undefined) return undefined
  const name = codeHostCredentials(provider)?.displayName ?? provider
  return `${provider.replaceAll('-', '_')}_requires_proxy: ${name} repositories are reached only through this daemon's credential proxy, and ${reason}`
}
