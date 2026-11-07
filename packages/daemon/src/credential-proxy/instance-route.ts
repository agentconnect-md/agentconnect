// The code-host instances the proxy serves besides GitHub, and the registry their route descriptors are dispatched through (github-app-git-credentials.md, Phase 2; azure-devops-integration.md §6.2).
import { parseManagedBaseUrl, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'
import { gitlabProxyRoute } from '../gitlab/proxy-route.js'
import { giteaProxyRoute } from '../gitea/proxy-route.js'
import { azureDevOpsProxyRoute } from '../azure-devops/proxy-route.js'
import { GITHUB_PROXY_HOSTS } from './github-route.js'
import type {
  InstanceRoute,
  ProxyInstance,
  ProxyRepository,
  ProxyRouteContext,
  ProxyRouteDescriptor
} from './route-descriptor.js'

export type { InstanceRoute, ProxyInstance, ProxyRepository, ProxyRouteContext } from './route-descriptor.js'

/** The SaaS hosts, which never resolve into private space; a self-managed instance may. */
export const SAAS_HOSTS: readonly string[] = [...GITHUB_PROXY_HOSTS, 'gitlab.com', 'gitea.com']

/** Adding a code host to the proxy is adding its descriptor here; GitHub routes through its own path. */
const DESCRIPTORS: Readonly<Record<string, ProxyRouteDescriptor>> = Object.fromEntries(
  [gitlabProxyRoute, giteaProxyRoute, azureDevOpsProxyRoute].map((descriptor) => [descriptor.provider, descriptor])
)

/** The descriptor a provider registered, if any. */
export function routeDescriptor(provider: string): ProxyRouteDescriptor | undefined {
  return Object.hasOwn(DESCRIPTORS, provider) ? DESCRIPTORS[provider] : undefined
}

/** A host as a base URL spells it: the name, and the port unless it is HTTPS's own. */
export function hostKey(hostname: string, port: number): string {
  const name = hostname.includes(':') ? `[${hostname}]` : hostname
  return port === 443 ? name : `${name}:${port}`
}

/** The proxy's view of a managed host; undefined for one it cannot carry (not HTTPS, or unparseable). */
export function proxyInstance(host: ManagedCredentialHost): ProxyInstance | undefined {
  if (host.provider === 'github') return { provider: 'github', hosts: GITHUB_PROXY_HOSTS, pathPrefix: '' }
  const parts = parseManagedBaseUrl(host.baseUrl)
  if (!parts || parts.protocol !== 'https') return undefined
  const instance = { provider: host.provider, hosts: [parts.host.replace(/:443$/, '')], pathPrefix: parts.pathPrefix }
  return routeDescriptor(host.provider)?.saas ? { ...instance, saas: true } : instance
}

/** The hosts the proxy serves an agent's managed host on, as its provider's descriptor derives them from the agent's repositories there (read only when it does). */
export function proxyHosts(
  host: ManagedCredentialHost,
  repositories: () => readonly ProxyRepository[]
): ManagedCredentialHost[] {
  const derive = routeDescriptor(host.provider)?.proxyHosts
  return derive ? derive(host, repositories()) : [host]
}

/** The instance's host names without a port: what DNS resolves and what srt routes. */
export function instanceHostnames(instance: ProxyInstance): string[] {
  return instance.hosts.map((host) => host.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1'))
}

/** The sealed host this request reaches on the instance, or undefined when the instance does not serve it. */
export function instanceHost(instance: ProxyInstance, hostname: string, port: number): string | undefined {
  // GitHub's names match on any port, as they always have; a self-managed host only on its own.
  const key = instance.provider === 'github' ? hostname : hostKey(hostname, port)
  return instance.hosts.includes(key) ? key : undefined
}

/** Route one request on an instance by its provider's descriptor; a provider without one is refused. */
export function instanceRoute(
  instance: ProxyInstance,
  method: string,
  target: string,
  context: ProxyRouteContext = { repositories: [] }
): InstanceRoute {
  const descriptor = routeDescriptor(instance.provider)
  if (!descriptor)
    return { kind: 'deny', status: 403, reason: `the credential proxy has no routes for ${instance.provider}` }
  const refused = descriptor.refusedHeaders?.find((name) => context.headers?.has(name))
  if (refused)
    return {
      kind: 'deny',
      status: 400,
      reason: `a request carrying ${refused} is not accepted with this agent's credential; send its method itself`
    }
  return descriptor.route(instance, method, target, context)
}
