// Admission checks shared by proxy-only providers; each Git invocation and runtime launch checks its current route.
import { codeHostCredentials } from '../codehost/credentials.js'

/** What decides whether the credential proxy carries one host of an agent. */
export interface ProxyOnlyReach {
  /** This daemon's credential proxy started. */
  proxyRunning: boolean
  /** The agent's spec gives it a managed code-host credential at all. */
  managedCredential: boolean
  /** Every proxy-only provider of the agent has an instance the proxy serves; read last. */
  served: () => boolean
}

function unreached(reach: ProxyOnlyReach): string | undefined {
  if (!reach.proxyRunning) return 'the credential proxy is not running on this daemon'
  if (!reach.managedCredential) return 'the agent holds no managed code-host credential'
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
