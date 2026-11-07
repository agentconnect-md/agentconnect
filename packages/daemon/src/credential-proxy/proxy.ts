// The daemon's code-host credential proxy (github-app-git-credentials.md, Phase 2): the environment holds a sealed placeholder, and each request is authenticated here with a token minted at its repository's tier.
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { lookup as dnsLookup } from 'node:dns'
import { isIP, type AddressInfo, type LookupFunction } from 'node:net'
import { join } from 'node:path'
import { createHttpProxyServer } from '@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js'
import { createMitmCA, disposeMitmCASync, type MitmCA } from '@anthropic-ai/sandbox-runtime/dist/sandbox/mitm-ca.js'
import type { DirectLookup } from '@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js'
import type { RequestDecision, RequestInfo } from '@anthropic-ai/sandbox-runtime/dist/sandbox/request-filter.js'
import type { ProxyCa } from './ca.js'
import { graphqlOperationTypes } from './graphql-operation.js'
import { GITHUB_PROXY_HOSTS, githubRoute, graphqlRepository } from './github-route.js'
import { looksLikePlaceholder, openPlaceholder, sealPlaceholder } from './placeholder.js'

/** A GraphQL body larger than this is refused rather than buffered. */
const MAX_GRAPHQL_BODY_BYTES = 1 << 20

/** How a write that GraphQL would carry is made instead. */
const GRAPHQL_WRITE_REFUSAL =
  'GraphQL writes are not available with this agent’s credential. Use the githubPullRequest, githubIssue or githubComment tool, or the REST API (`gh api -X POST …`).'

export interface CredentialProxyDeps {
  key: Buffer
  ca: ProxyCa
  /** A token for `repo` at the agent's tier (`readOnly` asks for read), from the daemon's credential cache. */
  mint: (agentId: string, repo: string, plane: 'git' | 'gh', readOnly: boolean) => Promise<string>
  /** The agent's GitHub workspace repository, `owner/repo`, for a read that names none. */
  workspaceRepo: (agentId: string) => string | undefined
  knownAgent: (agentId: string) => boolean
  log: { info: (message: string) => void; warn: (message: string) => void }
  /** Test seam: how upstream names resolve, and an extra authority the upstream leg trusts. */
  upstream?: { lookupFor?: DirectLookup; trustedCa?: string }
}

/** Loopback, private, link-local (cloud metadata) and unspecified space, where a code-host name must never resolve. */
export function deniedAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address
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

/** Resolve a code-host name and drop denied addresses, refusing when none is left; any other name resolves as usual. */
function guardedLookup(): DirectLookup {
  const lookup: LookupFunction = (hostname, options, callback) => {
    if (!GITHUB_PROXY_HOSTS.includes(hostname.toLowerCase())) {
      dnsLookup(hostname, options, callback)
      return
    }
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0)
      const allowed = addresses.filter((entry) => !deniedAddress(entry.address))
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

function deny(status: number, reason: string): RequestDecision {
  return { action: 'deny', status, reason, mark: 'credential-proxy' }
}

function authorization(scheme: Presented['scheme'], token: string): string {
  if (scheme === 'basic') return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  return `${scheme === 'bearer' ? 'Bearer' : 'token'} ${token}`
}

export class CredentialProxy {
  private loopback: Server | undefined
  /** srt's routes, one socket per agent, so a placeholder is honored only over its own agent's. */
  private readonly agentSockets = new Map<string, { path: string; server: Server }>()
  private socketDir: string | undefined
  private mitmCa: MitmCA | undefined
  private readonly proxyToken = randomBytes(24).toString('base64url')
  private loopbackPort: number | undefined

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
    const servers = [...(this.loopback ? [this.loopback] : []), ...[...this.agentSockets.values()].map((s) => s.server)]
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    this.loopback = undefined
    this.agentSockets.clear()
    if (this.mitmCa) disposeMitmCASync(this.mitmCa)
    this.mitmCa = undefined
  }

  /** The socket srt routes this agent's code-host domains to, listening from the first ask; only this agent's placeholder is honored there. */
  socketFor(agentId: string): string {
    const existing = this.agentSockets.get(agentId)
    if (existing) return existing.path
    if (!this.socketDir) throw new Error('the credential proxy is not running')
    // A digest, not the id: the path must fit AF_UNIX beside a long daemon root.
    const path = join(this.socketDir, `${createHash('sha256').update(agentId).digest('hex').slice(0, 16)}.sock`)
    rmSync(path, { force: true })
    const server = this.server(undefined, agentId)
    server.on('error', (err) => this.deps.log.warn(`credential proxy: socket for ${agentId} failed: ${err.message}`))
    // A Unix path binds inside listen() itself, so the socket exists before srt is handed it; only `listening` waits a tick.
    server.listen(path, () => chmodSync(path, 0o600))
    this.agentSockets.set(agentId, { path, server })
    return path
  }

  /** Retire an agent's route with the agent: its listener closes and its socket goes. */
  release(agentId: string): void {
    const route = this.agentSockets.get(agentId)
    if (!route) return
    this.agentSockets.delete(agentId)
    route.server.close()
    rmSync(route.path, { force: true })
  }

  /** The placeholder an agent's environment carries in place of a code-host token. */
  placeholderFor(agentId: string): string {
    return sealPlaceholder(this.deps.key, { agentId, hosts: [...GITHUB_PROXY_HOSTS] })
  }

  /** The proxy URL a runtime on this host reaches the loopback listener by, its proxy credential included. */
  loopbackUrl(): string | undefined {
    if (this.loopbackPort === undefined) return undefined
    return `http://srt:${this.proxyToken}@127.0.0.1:${this.loopbackPort}`
  }

  private server(proxyAuthToken?: string, boundAgent?: string): Server {
    return createHttpProxyServer({
      // Every host is reachable; only the code-host domains are terminated and judged.
      filter: () => true,
      mitmCA: this.mitmCa!,
      shouldTerminateTLS: (host) => GITHUB_PROXY_HOSTS.includes(host),
      filterRequest: (request, info) => this.decide(request, info, boundAgent),
      onFilterRequestDenied: ({ method, url, reason }) =>
        this.deps.log.info(`credential proxy refused ${method} ${url.split('?')[0]}: ${reason}`),
      requireHostMatch: true,
      ambiguousRequestTarget: 'refuse',
      lookupFor: this.deps.upstream?.lookupFor ?? guardedLookup(),
      ...(this.deps.upstream?.trustedCa ? { tlsTerminateUpstreamCA: this.deps.upstream.trustedCa } : {}),
      ...(proxyAuthToken ? { proxyAuthToken } : {})
    })
  }

  /** One request's decision: pass anything that is not ours untouched, and exchange our placeholder for the repository's token; over an agent's own socket, only that agent's. */
  async decide(request: Request, info?: RequestInfo, boundAgent?: string): Promise<RequestDecision> {
    const host = (info?.target?.host ?? new URL(request.url).hostname).toLowerCase()
    if (!GITHUB_PROXY_HOSTS.includes(host)) return { action: 'allow' }
    const presented = presentedCredential(request.headers.get('authorization'))
    if (!presented || !looksLikePlaceholder(presented.value)) return { action: 'allow' }
    if (info?.scheme !== 'https') return deny(403, 'the agent credential is only accepted over HTTPS')
    const claims = openPlaceholder(this.deps.key, presented.value)
    if (!claims) return deny(403, 'the agent credential was not issued by this daemon')
    if (!claims.hosts.includes(host)) return deny(403, `the agent credential is not valid for ${host}`)
    if (!this.deps.knownAgent(claims.agentId)) return deny(403, 'the agent credential belongs to no running agent')
    if (boundAgent !== undefined && claims.agentId !== boundAgent)
      return deny(403, 'the agent credential belongs to another agent')
    // Routed by the bytes that go upstream; an ambiguous spelling was refused before this runs.
    const url = new URL(request.url)
    const route = githubRoute(host, request.method, info.requestTarget ?? `${url.pathname}${url.search}`)
    let repo: string | undefined
    let plane: 'git' | 'gh' = 'gh'
    let readOnly = true
    switch (route.kind) {
      case 'deny':
        return deny(route.status, route.reason)
      case 'anonymous':
        return { action: 'allow', removeHeaders: ['authorization'] }
      case 'workspace':
        repo = this.deps.workspaceRepo(claims.agentId)
        if (!repo) return deny(403, 'this agent has no GitHub workspace repository to read with')
        break
      case 'graphql': {
        const body = await this.graphqlBody(request)
        if (typeof body === 'string') return deny(400, body)
        const types = typeof body.query === 'string' ? graphqlOperationTypes(body.query) : undefined
        if (!types || types.length === 0) return deny(400, 'the GraphQL document could not be read')
        if (types.some((type) => type !== 'query')) return deny(403, GRAPHQL_WRITE_REFUSAL)
        repo = graphqlRepository(body.variables) ?? this.deps.workspaceRepo(claims.agentId)
        if (!repo) return deny(403, 'the GraphQL request names no repository this agent can read')
        break
      }
      case 'repository':
        repo = route.repo
        plane = route.plane
        readOnly = route.readOnly
        break
    }
    try {
      const token = await this.deps.mint(claims.agentId, repo, plane, readOnly)
      return { action: 'allow', setHeaders: [['authorization', authorization(presented.scheme, token)]] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log.warn(`credential proxy: no token for ${claims.agentId} on ${repo}: ${message}`)
      return deny(403, `this agent is not authorized for ${repo}`)
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
