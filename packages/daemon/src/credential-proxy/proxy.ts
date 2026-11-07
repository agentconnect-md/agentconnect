// The daemon's credential proxy (github-app-git-credentials.md, Phase 2): the environment holds sealed placeholders, and each request is authenticated here with a token minted at its repository's tier or its provider slot's API key.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { lookup as dnsLookup } from 'node:dns'
import { isIP, type AddressInfo, type LookupFunction } from 'node:net'
import { join } from 'node:path'
import { createHttpProxyServer } from '@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'
import { createMitmCA, disposeMitmCASync, type MitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import {
  canonicalizeHost,
  resolveParentProxy,
  shouldBypassParentProxy,
  type DirectLookup,
  type ResolvedParentProxy
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import type { RequestDecision, RequestInfo } from '@anthropic-ai/sandbox-runtime/dist/sandbox/request-filter.js'
import type { ProxyCa } from './ca.js'
import { graphqlOperationTypes } from './graphql-operation.js'
import { githubRoute, graphqlRepository } from './github-route.js'
import {
  hostKey,
  instanceHost,
  instanceHostnames,
  instanceRoute,
  proxyInstance,
  routeDescriptor,
  SAAS_HOSTS,
  type ProxyInstance,
  type ProxyRepository
} from './instance-route.js'
import { requestPath, type InstanceRoute } from './route-descriptor.js'
import { upstreamGet, UpstreamAnswerTooLarge, type UpstreamAnswer, type UpstreamRoute } from './upstream.js'
import { looksLikePlaceholder, openPlaceholder, sealPlaceholder, type OpenedClaims } from './placeholder.js'
import {
  providerKeyPlaceholders,
  slotHostKey,
  slotHostname,
  slotServes,
  underSlotPrefix,
  type CarriedKey,
  type ProviderSlot,
  type ResolvedProviderKey
} from './provider-route.js'
import { stripHostPathPrefix, type ManagedCredentialHost } from '../gitcred/managed-hosts.js'

/** How long a resolved provider key is reused; a 401 from the upstream drops it sooner. */
const PROVIDER_KEY_TTL_MS = 60_000

/** A GraphQL body larger than this is refused rather than buffered. */
const MAX_GRAPHQL_BODY_BYTES = 1 << 20

/** How a write that GraphQL would carry is made instead. */
const GRAPHQL_WRITE_REFUSAL =
  'GraphQL writes are not available with this agent’s credential. Use the githubPullRequest, githubIssue or githubComment tool, or the REST API (`gh api -X POST …`).'

/** What one request needs minted: a repository on an instance (none names the workspace), for git or the API. */
export interface MintAsk {
  provider: string
  repo?: string
  /** The repository's numeric id: GitLab's API names a project by it, and a proxy-only provider's lease always does. */
  repoId?: string
  plane: 'git' | 'api'
  readOnly: boolean
  /** A git push, refused unless the grant is `write`: some hosts cannot narrow the token itself. */
  push?: true
  /** An API write, refused unless the grant is `write`, as a push is. */
  write?: true
}

/** A minted credential and the tier its grant carries. */
export interface MintedCredential {
  username: string
  token: string
  access: 'read' | 'comment' | 'write'
  /** Drops exactly the cache entry that minted this token, when it still holds it. */
  invalidate?: () => void
}

export interface CredentialProxyDeps {
  key: Buffer
  ca: ProxyCa
  /** The credential for the ask at the agent's tier (`readOnly` asks for read), from the daemon's credential cache. */
  mint: (agentId: string, ask: MintAsk) => Promise<MintedCredential>
  /** The agent's GitHub workspace repository, `owner/repo`, for a read that names none. */
  workspaceRepo: (agentId: string) => string | undefined
  /** The code-host instances an agent's managed credential reaches, from its spec. */
  instancesOf: (agentId: string) => readonly ManagedCredentialHost[]
  /** The agent's authorized repositories on one provider, from its spec, which that provider's routes resolve a request among. */
  repositoriesOf?: (agentId: string, provider: string) => readonly ProxyRepository[]
  /** Every agent this daemon runs, whose instances the shared loopback listener serves. */
  runningAgents: () => Iterable<string>
  knownAgent: (agentId: string) => boolean
  /** The provider API key slots an agent may use; none when unset. */
  providerSlotsOf?: (agentId: string) => readonly ProviderSlot[]
  /** A slot's real key, resolved when a request presents its placeholder. */
  resolveProviderSlot?: (agentId: string, slotId: string) => Promise<ResolvedProviderKey>
  log: { info: (message: string) => void; warn: (message: string) => void }
  /** How upstream names resolve (a test seam), and the authorities the upstream leg trusts. */
  upstream?: { lookupFor?: DirectLookup; trustedCa?: string | string[] }
}

/** A `host:port` authority, an IPv6 host bracketed, as a codehost listener matches a CONNECT. */
export function routeAuthority(hostname: string, port: number): string {
  return `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`
}

function ipv4Of(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/** Loopback, link-local (cloud metadata) and unspecified space, where even a self-managed instance's name must never resolve. */
export function deniedSelfManagedAddress(address: string): boolean {
  const v4 = ipv4Of(address)
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number)
    return a === 0 || a === 127 || (a === 169 && b === 254)
  }
  const v6 = address.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^fe[89ab]/.test(v6)
}

/** Loopback, private, link-local (cloud metadata) and unspecified space, where a SaaS code-host name must never resolve. */
export function deniedAddress(address: string): boolean {
  const v4 = ipv4Of(address)
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  const v6 = address.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
}

/** Resolve a code-host name and drop the addresses `denied` names, refusing when none is left; any other name resolves as usual. */
function guardedLookup(deniedFor: (hostname: string) => ((address: string) => boolean) | undefined): DirectLookup {
  const lookup: LookupFunction = (hostname, options, callback) => {
    const denied = deniedFor(hostname.toLowerCase())
    if (!denied) {
      dnsLookup(hostname, options, callback)
      return
    }
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      const allowed = addresses.filter((entry) => !denied(entry.address))
      if (allowed.length === 0) return callback(new Error(`${hostname} resolves only to denied addresses`), '', 0)
      if (options.all) return (callback as (e: null, a: typeof allowed) => void)(null, allowed)
      return callback(null, allowed[0]!.address, allowed[0]!.family)
    })
  }
  return () => lookup
}

interface Presented {
  scheme: 'basic' | 'bearer' | 'token'
  value: string
}

/** The credential an Authorization header presents, if any. */
export function presentedCredential(header: string | null): Presented | undefined {
  if (!header) return undefined
  const space = header.indexOf(' ')
  if (space === -1) return undefined
  const scheme = header.slice(0, space).toLowerCase()
  const rest = header.slice(space + 1).trim()
  if (scheme === 'bearer' || scheme === 'token') return { scheme, value: rest }
  if (scheme !== 'basic') return undefined
  const decoded = Buffer.from(rest, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  // git sends the placeholder as the password; a client that puts it in the user name is read the same way.
  const user = colon === -1 ? decoded : decoded.slice(0, colon)
  const password = colon === -1 ? '' : decoded.slice(colon + 1)
  return { scheme: 'basic', value: password || user }
}

/** One slot's key resolution and when it started. */
interface ProviderKeyEntry {
  at: number
  key: Promise<ResolvedProviderKey>
}

// The slot's destination is part of the identity, so a slot replaced at another endpoint never reuses the old endpoint's key.
function providerKeyId(agentId: string, slot: ProviderSlot): string {
  return `${agentId}\n${slot.id}\n${slot.provider}\n${slotHostKey(slot)}\n${slot.pathPrefix ?? ''}`
}

/** Which credentials a listener exchanges: an executor tunnel's socket carries one kind, every other listener both. */
type ListenerScope = 'codehost' | 'provider' | 'both'

function deny(status: number, reason: string): RequestDecision {
  return { action: 'deny', status, reason, mark: 'credential-proxy' }
}

/** The minted credential in the form the client presented the placeholder: Basic with the grant's user name, else the same scheme. */
function authorization(scheme: Presented['scheme'], minted: { username: string; token: string }): string {
  const user = minted.username || 'x-access-token'
  if (scheme === 'basic') return `Basic ${Buffer.from(`${user}:${minted.token}`).toString('base64')}`
  return `${scheme === 'bearer' ? 'Bearer' : 'token'} ${minted.token}`
}

/** Where a request carries our placeholder: the Authorization header, and GitLab's `PRIVATE-TOKEN`. */
interface Carried {
  authorization?: Presented
  privateToken?: string
}

function carriedPlaceholders(request: Request): Carried | undefined {
  const presented = presentedCredential(request.headers.get('authorization'))
  const privateToken = request.headers.get('private-token')?.trim()
  const carried: Carried = {
    ...(presented && looksLikePlaceholder(presented.value) ? { authorization: presented } : {}),
    ...(privateToken && looksLikePlaceholder(privateToken) ? { privateToken } : {})
  }
  return carried.authorization || carried.privateToken ? carried : undefined
}

export class CredentialProxy {
  private loopback: Server | undefined
  /** srt's routes, one socket per agent, so a placeholder is honored only over its own agent's. */
  private readonly agentSockets = new Map<string, { path: string; server: Server }>()
  /** An executor's codehost tunnel per agent: the same binding, and a CONNECT only to that agent's code hosts. */
  private readonly tunnelSockets = new Map<string, { path: string; server: Server }>()
  /** An executor's or VM's provider tunnel per agent: the same binding, and a CONNECT only to that agent's provider slots. */
  private readonly providerTunnelSockets = new Map<string, { path: string; server: Server }>()
  private socketDir: string | undefined
  private mitmCa: MitmCA | undefined
  private readonly proxyToken = randomBytes(24).toString('base64url')
  private loopbackPort: number | undefined
  /** Resolved provider keys by agent and slot, each kept until its TTL or the upstream's 401. */
  private readonly providerKeys = new Map<string, ProviderKeyEntry>()

  /** The daemon's own outbound proxy (HTTPS_PROXY, NO_PROXY) every upstream leg goes through; it resolves the names it carries, so on that route only a literal address is guarded here. */
  private readonly parentProxy: ResolvedParentProxy | undefined = resolveParentProxy()

  constructor(private readonly deps: CredentialProxyDeps) {}

  /** Listen on an authenticated loopback port, and keep the per-agent srt sockets under `runDir`. */
  async start(runDir: string): Promise<void> {
    this.mitmCa = createMitmCA({
      caCertPem: this.deps.ca.certPem,
      caKeyPem: this.deps.ca.keyPem,
      caCertPath: this.deps.ca.certPath,
      caKeyPath: this.deps.ca.keyPath
    })
    this.socketDir = join(runDir, 'codehost')
    rmSync(this.socketDir, { recursive: true, force: true })
    mkdirSync(this.socketDir, { recursive: true, mode: 0o700 })
    const loopback = this.server(this.proxyToken)
    await new Promise<void>((resolve, reject) => {
      loopback.once('error', reject)
      loopback.listen(0, '127.0.0.1', () => resolve())
    })
    this.loopbackPort = (loopback.address() as AddressInfo).port
    this.loopback = loopback
  }

  async stop(): Promise<void> {
    const servers = [
      ...(this.loopback ? [this.loopback] : []),
      ...[...this.agentSockets.values(), ...this.tunnelSockets.values(), ...this.providerTunnelSockets.values()].map(
        (s) => s.server
      )
    ]
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    this.loopback = undefined
    this.agentSockets.clear()
    this.tunnelSockets.clear()
    this.providerTunnelSockets.clear()
    if (this.mitmCa) disposeMitmCASync(this.mitmCa)
    this.mitmCa = undefined
  }

  /** The socket srt routes this agent's code-host domains to, listening from the first ask; only this agent's placeholder is honored there. */
  socketFor(agentId: string): string {
    return this.agentSocket(this.agentSockets, agentId, '', () => this.server(undefined, agentId))
  }

  /** The socket an executor's codehost tunnel reaches for this agent: its code-host placeholder alone, and a CONNECT to nothing but its {@link tunnelRoutes}. */
  tunnelSocketFor(agentId: string): string {
    return this.agentSocket(this.tunnelSockets, agentId, '-t', () =>
      this.server(
        undefined,
        agentId,
        (port, host) => this.tunnelRoutes(agentId).includes(routeAuthority(host, port)),
        'codehost'
      )
    )
  }

  /** The `host:port` authorities an agent's code hosts answer on: each SaaS name on 443, a self-managed instance on its own port. */
  tunnelRoutes(agentId: string): string[] {
    const routes = this.instances(agentId).flatMap((instance) =>
      instance.provider === 'github'
        ? instanceHostnames(instance).map((name) => routeAuthority(name, 443))
        : instance.hosts.map((host) => (/:\d+$/.test(host) ? host : `${host}:443`))
    )
    return [...new Set(routes)]
  }

  /** The socket a provider tunnel reaches for this agent: its provider placeholders alone, and a CONNECT to nothing but its {@link providerTunnelRoutes}. */
  providerTunnelSocketFor(agentId: string): string {
    return this.agentSocket(this.providerTunnelSockets, agentId, '-p', () =>
      this.server(
        undefined,
        agentId,
        (port, host) => this.providerTunnelRoutes(agentId).includes(routeAuthority(host, port)),
        'provider'
      )
    )
  }

  /** The `host:port` authorities an agent's provider slots answer on. */
  providerTunnelRoutes(agentId: string): string[] {
    return [...new Set(this.slots(agentId).map((slot) => routeAuthority(slotHostname(slot), slot.port)))]
  }

  private agentSocket(
    sockets: Map<string, { path: string; server: Server }>,
    agentId: string,
    suffix: string,
    create: () => Server
  ): string {
    const existing = sockets.get(agentId)
    if (existing) return existing.path
    if (!this.socketDir) throw new Error('the credential proxy is not running')
    // A digest, not the id: the path must fit AF_UNIX beside a long daemon root.
    const digest = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
    const path = join(this.socketDir, `${digest}${suffix}.sock`)
    rmSync(path, { force: true })
    const server = create()
    server.on('error', (err) => this.deps.log.warn(`credential proxy: socket for ${agentId} failed: ${err.message}`))
    // A Unix path binds inside listen() itself, so the socket exists before srt is handed it; only `listening` waits a tick.
    server.listen(path, () => chmodSync(path, 0o600))
    sockets.set(agentId, { path, server })
    return path
  }

  /** Retire an agent's routes with the agent: its listeners close and their sockets go. */
  release(agentId: string): void {
    for (const id of this.providerKeys.keys()) if (id.startsWith(`${agentId}\n`)) this.providerKeys.delete(id)
    for (const sockets of [this.agentSockets, this.tunnelSockets, this.providerTunnelSockets]) {
      const route = sockets.get(agentId)
      if (!route) continue
      sockets.delete(agentId)
      route.server.close()
      rmSync(route.path, { force: true })
    }
  }

  /** The placeholder an agent's environment carries in place of a code-host token, sealed for its own instances' hosts. */
  placeholderFor(agentId: string): string {
    const hosts = [...new Set(this.instances(agentId).flatMap((instance) => instance.hosts))]
    return sealPlaceholder(this.deps.key, { agentId, hosts })
  }

  /** The placeholder an agent's environment carries in place of one provider slot's key; undefined for a slot it does not have. */
  providerPlaceholderFor(agentId: string, slotId: string): string | undefined {
    const slot = this.slots(agentId).find((candidate) => candidate.id === slotId)
    return slot && this.sealProviderSlot(agentId, slot)
  }

  /** The placeholder for one provider slot, which the proxy accepts once the agent's deps name that slot. */
  sealProviderSlot(agentId: string, slot: ProviderSlot): string {
    return sealPlaceholder(this.deps.key, { agentId, hosts: [slotHostKey(slot)], kind: 'provider', slot: slot.id })
  }

  /** The host names srt routes to this agent's socket: its instances' and its provider slots', never another agent's. */
  domainsFor(agentId: string): string[] {
    return [
      ...new Set([...this.instances(agentId).flatMap(instanceHostnames), ...this.slots(agentId).map(slotHostname)])
    ]
  }

  /** A host session's NO_PROXY: loopback, and the inherited entries but those that would send one of the agent's intercepted hosts around this proxy. */
  sessionNoProxy(agentId: string, inherited: string | undefined): string {
    const domains = this.domainsFor(agentId)
    const kept = (inherited ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => {
        const rules = entry ? resolveParentProxy({ https: 'http://parent.invalid', noProxy: entry }) : undefined
        return rules !== undefined && !domains.some((domain) => shouldBypassParentProxy(rules, domain))
      })
    return ['localhost', '127.0.0.1', '::1', ...kept].join(',')
  }

  /** The proxy URL a runtime on this host reaches the loopback listener by, its proxy credential included. */
  loopbackUrl(): string | undefined {
    if (this.loopbackPort === undefined) return undefined
    return `http://srt:${this.proxyToken}@127.0.0.1:${this.loopbackPort}`
  }

  /** The instances an agent's credential reaches, as the proxy matches them. */
  private instances(agentId: string): ProxyInstance[] {
    return this.deps.instancesOf(agentId).flatMap((host) => proxyInstance(host) ?? [])
  }

  /** The instances a listener serves: its own agent's on a socket, every running agent's on loopback. */
  private served(boundAgent?: string): ProxyInstance[] {
    return boundAgent !== undefined
      ? this.instances(boundAgent)
      : [...this.deps.runningAgents()].flatMap((id) => this.instances(id))
  }

  /** An agent's provider slots, as its deps name them. */
  private slots(agentId: string): readonly ProviderSlot[] {
    return this.deps.providerSlotsOf?.(agentId) ?? []
  }

  /** The provider slots a listener serves: its own agent's on a socket, every running agent's on loopback. */
  private servedSlots(boundAgent?: string): ProviderSlot[] {
    return boundAgent !== undefined
      ? [...this.slots(boundAgent)]
      : [...this.deps.runningAgents()].flatMap((id) => this.slots(id))
  }

  /** Which address space a name may not resolve into: all private space for a SaaS host or provider origin, only loopback, link-local and unspecified for a self-managed instance or an operator's endpoint. */
  private deniedFor(hostname: string): ((address: string) => boolean) | undefined {
    const slots = this.servedSlots().filter((slot) => slotHostname(slot) === hostname)
    const instances = this.served().filter((instance) => instanceHostnames(instance).includes(hostname))
    if (SAAS_HOSTS.includes(hostname) || slots.some((slot) => slot.saas) || instances.some((i) => i.saas))
      return deniedAddress
    return slots.length > 0 || instances.length > 0 ? deniedSelfManagedAddress : undefined
  }

  /** A code host or provider named by an address in its denied space, which no name lookup on either route would catch. */
  private deniedLiteral(host: string): boolean {
    const name = (canonicalizeHost(host) ?? host).replace(/^\[(.*)\]$/, '$1')
    return isIP(name) !== 0 && (this.deniedFor(name)?.(name) ?? false)
  }

  private server(
    proxyAuthToken?: string,
    boundAgent?: string,
    reachable: (port: number, host: string) => boolean = () => true,
    scope: ListenerScope = 'both'
  ): Server {
    const trustedCa = this.deps.upstream?.trustedCa
    return createHttpProxyServer({
      // Every host is reachable unless the listener narrows it; only the code-host instances and provider slots are terminated and judged.
      filter: (port, host) =>
        reachable(port, host.toLowerCase().replace(/^\[(.*)\]$/, '$1')) && !this.deniedLiteral(host),
      mitmCA: this.mitmCa!,
      shouldTerminateTLS: (host, port) =>
        (scope !== 'provider' &&
          this.served(boundAgent).some((instance) => instanceHost(instance, host.toLowerCase(), port) !== undefined)) ||
        (scope !== 'codehost' &&
          this.servedSlots(boundAgent).some((slot) => slotServes(slot, host.toLowerCase(), port))),
      filterRequest: (request, info) => this.decide(request, info, boundAgent, scope),
      onFilterRequestDenied: ({ method, url, reason }) =>
        this.deps.log.info(`credential proxy refused ${method} ${url.split('?')[0]}: ${reason}`),
      requireHostMatch: true,
      ambiguousRequestTarget: 'refuse',
      lookupFor: this.deps.upstream?.lookupFor ?? guardedLookup((hostname) => this.deniedFor(hostname)),
      ...(this.parentProxy ? { parentProxy: this.parentProxy } : {}),
      ...(trustedCa && trustedCa.length > 0 ? { tlsTerminateUpstreamCA: trustedCa } : {}),
      ...(proxyAuthToken ? { proxyAuthToken } : {})
    })
  }

  /** One request's decision: pass anything that is not ours untouched, and exchange our placeholder for the repository's token or the provider's key; over an agent's own socket, only that agent's, and over a tunnel's, only its kind. */
  async decide(
    request: Request,
    info?: RequestInfo,
    boundAgent?: string,
    scope: ListenerScope = 'both'
  ): Promise<RequestDecision> {
    const url = new URL(request.url)
    const hostname = (info?.target?.host ?? url.hostname).toLowerCase().replace(/^\[(.*)\]$/, '$1')
    const port = info?.target?.port ?? (url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443)
    // Judged by name on any port, so a placeholder sent in cleartext is refused below rather than forwarded.
    const codeHost =
      scope !== 'provider' && this.served(boundAgent).some((instance) => instanceHostnames(instance).includes(hostname))
    const providerHost =
      scope !== 'codehost' && this.servedSlots(boundAgent).some((slot) => slotHostname(slot) === hostname)
    if (!codeHost && !providerHost) return { action: 'allow' }
    const carried = codeHost ? carriedPlaceholders(request) : undefined
    const keyed = providerHost ? providerKeyPlaceholders(request.headers) : []
    const presented = [
      ...(carried?.authorization ? [carried.authorization.value] : []),
      ...(carried?.privateToken ? [carried.privateToken] : []),
      ...keyed.map((entry) => entry.value)
    ]
    if (presented.length === 0) return { action: 'allow' }
    if (info?.scheme !== 'https') return deny(403, 'the agent credential is only accepted over HTTPS')
    const opened = presented.map((value) => openPlaceholder(this.deps.key, value))
    if (opened.some((claims) => !claims)) return deny(403, 'the agent credential was not issued by this daemon')
    const claims = opened[0]!
    if (opened.some((o) => o!.agentId !== claims.agentId || o!.kind !== claims.kind || o!.slot !== claims.slot))
      return deny(403, 'the request carries more than one agent credential')
    // The kind first: a code-host credential is never a provider key, nor the reverse.
    if (claims.kind === 'provider' ? keyed.length === 0 : !carried)
      return deny(403, `the agent credential is not valid for ${hostKey(hostname, port)}`)
    if (!this.deps.knownAgent(claims.agentId)) return deny(403, 'the agent credential belongs to no running agent')
    if (boundAgent !== undefined && claims.agentId !== boundAgent)
      return deny(403, 'the agent credential belongs to another agent')
    // Routed by the bytes that go upstream; an ambiguous spelling was refused before this runs.
    const target = info.requestTarget ?? `${url.pathname}${url.search}`
    if (claims.kind === 'provider') return this.providerDecision(claims, keyed, hostname, port, target)
    if (!carried) return deny(403, `the agent credential is not valid for ${hostKey(hostname, port)}`)
    const instance = this.instanceFor(claims.agentId, claims.hosts, hostname, port, target)
    if (!instance) return deny(403, `the agent credential is not valid for ${hostKey(hostname, port)}`)
    // A descriptor may present every credential as Basic with the grant's user, whatever scheme the client used.
    const scheme = routeDescriptor(instance.provider)?.basicAuthorization ? 'basic' : carried.authorization?.scheme
    const ask =
      instance.provider === 'github'
        ? await this.githubAsk(request, claims.agentId, hostname, target)
        : await this.instanceAsk(claims.agentId, instance, request, { hostname, port, target, scheme })
    if (ask === 'anonymous')
      return {
        action: 'allow',
        removeHeaders: [
          ...(carried.authorization ? ['authorization'] : []),
          ...(carried.privateToken ? ['private-token'] : [])
        ]
      }
    if ('action' in ask) return ask
    const what = ask.repo ?? (ask.repoId !== undefined ? `project ${ask.repoId}` : 'the workspace repository')
    try {
      const minted = await this.deps.mint(claims.agentId, ask)
      if (ask.push && minted.access !== 'write')
        return deny(403, `this agent has ${minted.access} access to ${what}; pushing needs write access`)
      if (ask.write && minted.access !== 'write')
        return deny(403, `this agent has ${minted.access} access to ${what}; writing needs write access`)
      const setHeaders: [string, string][] = []
      if (carried.authorization && scheme) setHeaders.push(['authorization', authorization(scheme, minted)])
      if (carried.privateToken) setHeaders.push(['private-token', minted.token])
      const { invalidate } = minted
      if (!invalidate) return { action: 'allow', setHeaders }
      // A token the upstream rejects as revoked or rotated is minted afresh next time; a 403 is a tier refusal and keeps it.
      return {
        action: 'allow',
        setHeaders,
        onResponse: (status) => {
          if (status === 401) invalidate()
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log.warn(`credential proxy: no token for ${claims.agentId} on ${what}: ${message}`)
      return deny(403, `this agent is not authorized for ${what}`)
    }
  }

  /** A provider placeholder's decision: the slot's real key in each header it came in plus the slot's extra headers; outside the slot's prefix, no key at all. */
  private async providerDecision(
    claims: OpenedClaims,
    keyed: CarriedKey[],
    hostname: string,
    port: number,
    target: string
  ): Promise<RequestDecision> {
    const slot = this.slots(claims.agentId).find((candidate) => candidate.id === claims.slot)
    if (!slot || !slotServes(slot, hostname, port) || !claims.hosts.includes(slotHostKey(slot)))
      return deny(403, `the agent credential is not valid for ${hostKey(hostname, port)}`)
    if (!underSlotPrefix(slot, target)) return { action: 'allow', removeHeaders: keyed.map((entry) => entry.header) }
    if (keyed.some((entry) => entry.scheme !== undefined && entry.scheme !== 'bearer'))
      return deny(400, 'a provider key is accepted in Authorization only as a Bearer token')
    const id = providerKeyId(claims.agentId, slot)
    const entry = this.providerKeyEntry(id, claims.agentId, slot.id)
    let resolved: ResolvedProviderKey
    try {
      resolved = await entry.key
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log.warn(`credential proxy: no ${slot.provider} key for ${claims.agentId} (${slot.id}): ${message}`)
      return deny(403, `this agent has no ${slot.provider} key available`)
    }
    const keyHeaders = keyed.map((carried): [string, string] => [
      carried.header,
      carried.header === 'authorization' ? `Bearer ${resolved.key}` : resolved.key
    ])
    return {
      action: 'allow',
      setHeaders: [...keyHeaders, ...Object.entries(resolved.headers ?? {})],
      // A key the upstream rejects is resolved afresh on the next request.
      onResponse: (status) => {
        if (status === 401 && this.providerKeys.get(id) === entry) this.providerKeys.delete(id)
      }
    }
  }

  /** The cached resolution of a slot's key, started afresh past its TTL; a failed one is not kept. */
  private providerKeyEntry(id: string, agentId: string, slotId: string): ProviderKeyEntry {
    const cached = this.providerKeys.get(id)
    if (cached && Date.now() - cached.at < PROVIDER_KEY_TTL_MS) return cached
    const resolve = this.deps.resolveProviderSlot
    const key = (async () => {
      if (!resolve) throw new Error('no provider key resolver')
      return resolve(agentId, slotId)
    })()
    const entry = { at: Date.now(), key }
    this.providerKeys.set(id, entry)
    key.catch(() => {
      if (this.providerKeys.get(id) === entry) this.providerKeys.delete(id)
    })
    return entry
  }

  /** The agent's instance a request reaches, among those its placeholder was sealed for: the longest path prefix that applies. */
  private instanceFor(
    agentId: string,
    sealed: readonly string[],
    hostname: string,
    port: number,
    target: string
  ): ProxyInstance | undefined {
    const path = target.split('?')[0] ?? ''
    const candidates = this.instances(agentId).filter((instance) => {
      const host = instanceHost(instance, hostname, port)
      return host !== undefined && sealed.includes(host)
    })
    const applying = candidates
      .filter((instance) => stripHostPathPrefix(path, instance.pathPrefix) !== undefined)
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)
    return applying[0] ?? candidates[0]
  }

  /** What a request on one of the agent's instances needs, by its provider's registered descriptor. */
  private async instanceAsk(
    agentId: string,
    instance: ProxyInstance,
    request: Request,
    at: { hostname: string; port: number; target: string; scheme: Presented['scheme'] | undefined }
  ): Promise<MintAsk | RequestDecision | 'anonymous'> {
    const repositories = this.deps.repositoriesOf?.(agentId, instance.provider) ?? []
    const route = instanceRoute(instance, request.method, at.target, { repositories, headers: request.headers })
    switch (route.kind) {
      case 'deny':
        return deny(route.status, route.reason)
      case 'anonymous':
        return 'anonymous'
      case 'workspace':
        return { provider: instance.provider, plane: 'api', readOnly: true }
      case 'repository':
        return {
          provider: instance.provider,
          ...(route.repo !== undefined ? { repo: route.repo } : {}),
          ...(route.repoId !== undefined ? { repoId: route.repoId } : {}),
          plane: route.plane,
          readOnly: route.readOnly ?? route.plane === 'api',
          ...(route.push ? { push: true as const } : {}),
          ...(route.write ? { write: true as const } : {})
        }
      case 'lookup':
        return await this.lookupOwner(agentId, instance.provider, route, at)
    }
  }

  /** Ask the upstream itself, with a read lease, which repository a request's target is in; a refusal other than a rejected credential or a rate limit, and an answer it cannot read, is answered `hidden`, so the lookup is no oracle. */
  private async lookupOwner(
    agentId: string,
    provider: string,
    route: Extract<InstanceRoute, { kind: 'lookup' }>,
    at: { hostname: string; port: number; scheme: Presented['scheme'] | undefined }
  ): Promise<MintAsk | RequestDecision> {
    const lease: MintAsk = { provider, ...route.via, plane: 'api', readOnly: true }
    const hidden = deny(route.hidden.status, route.hidden.reason)
    // One retry after a 401, with the rejected token dropped, as a forwarded request's next one would be.
    for (let attempt = 0; ; attempt += 1) {
      let minted: MintedCredential
      try {
        minted = await this.deps.mint(agentId, lease)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.deps.log.warn(`credential proxy: no token for ${agentId} on ${route.via.repo}: ${message}`)
        // The lease's repository is not what the request asked about, so the answer does not name it.
        return deny(403, 'no credential of this agent could be obtained to check this request')
      }
      let answer: UpstreamAnswer
      try {
        // Its own target and a fixed `accept`, so nothing the client sends shapes the answer.
        answer = await upstreamGet(
          at.hostname,
          at.port,
          route.target,
          { authorization: authorization(at.scheme ?? 'basic', minted), ...route.headers, accept: 'application/json' },
          this.upstreamRoute(at.port)
        )
      } catch (err) {
        if (err instanceof UpstreamAnswerTooLarge) return hidden
        this.deps.log.warn(`credential proxy: lookup of ${requestPath(route.target)} failed: ${(err as Error).message}`)
        return deny(502, 'the code host could not be reached to check this request')
      }
      if (answer.status === 401 && attempt === 0) {
        minted.invalidate?.()
        continue
      }
      if (answer.status === 429) {
        const after = answer.headers['retry-after']
        return deny(429, `the code host is rate limiting this identity${after ? ` (Retry-After: ${after})` : ''}`)
      }
      // Any other refusal reads as a missing target, whatever it says about one the agent does not hold.
      if (answer.status >= 400 && answer.status < 500 && answer.status !== 401) return hidden
      if (answer.status !== 200)
        return deny(502, `the code host answered ${answer.status} when this request was checked`)
      let parsed: unknown
      try {
        parsed = JSON.parse(answer.body.toString('utf8'))
      } catch {
        return hidden
      }
      const owner = route.owner(parsed)
      if (!owner) return hidden
      return {
        provider,
        ...owner,
        plane: 'api',
        readOnly: !route.write,
        ...(route.write ? { write: true as const } : {})
      }
    }
  }

  /** How the proxy's own upstream request leaves: the route its forwarded legs take. */
  private upstreamRoute(port: number): UpstreamRoute {
    const lookupFor = this.deps.upstream?.lookupFor ?? guardedLookup((hostname) => this.deniedFor(hostname))
    const trustedCa = this.deps.upstream?.trustedCa
    return {
      ...(this.parentProxy ? { parentProxy: this.parentProxy } : {}),
      lookup: lookupFor(port),
      ...(trustedCa !== undefined ? { trustedCa } : {})
    }
  }

  private async githubAsk(
    request: Request,
    agentId: string,
    host: string,
    target: string
  ): Promise<MintAsk | RequestDecision | 'anonymous'> {
    const route = githubRoute(host, request.method, target)
    switch (route.kind) {
      case 'deny':
        return deny(route.status, route.reason)
      case 'anonymous':
        return 'anonymous'
      case 'workspace': {
        const repo = this.deps.workspaceRepo(agentId)
        if (!repo) return deny(403, 'this agent has no GitHub workspace repository to read with')
        return { provider: 'github', repo, plane: 'api', readOnly: true }
      }
      case 'graphql': {
        const body = await this.graphqlBody(request)
        if (typeof body === 'string') return deny(400, body)
        const types = typeof body.query === 'string' ? graphqlOperationTypes(body.query) : undefined
        if (!types || types.length === 0) return deny(400, 'the GraphQL document could not be read')
        if (types.some((type) => type !== 'query')) return deny(403, GRAPHQL_WRITE_REFUSAL)
        const repo = graphqlRepository(body.variables) ?? this.deps.workspaceRepo(agentId)
        if (!repo) return deny(403, 'the GraphQL request names no repository this agent can read')
        return { provider: 'github', repo, plane: 'api', readOnly: true }
      }
      case 'repository':
        return {
          provider: 'github',
          repo: route.repo,
          plane: route.plane === 'git' ? 'git' : 'api',
          readOnly: route.readOnly,
          ...(route.push ? { push: true as const } : {})
        }
    }
  }

  private async graphqlBody(request: Request): Promise<{ query?: unknown; variables?: unknown } | string> {
    const length = Number(request.headers.get('content-length') ?? '0')
    if (length > MAX_GRAPHQL_BODY_BYTES) return 'the GraphQL request is too large'
    const text = await request.text()
    if (Buffer.byteLength(text) > MAX_GRAPHQL_BODY_BYTES) return 'the GraphQL request is too large'
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return 'the GraphQL request is not a single JSON object'
      return parsed as { query?: unknown; variables?: unknown }
    } catch {
      return 'the GraphQL request is not JSON'
    }
  }
}
