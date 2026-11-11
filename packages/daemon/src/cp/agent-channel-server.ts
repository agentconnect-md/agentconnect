// agent.sock, the agent channel: live secrets for the runtime, git credentials for the daemon's own git and the in-pod auto-merge watcher (github-app-git-credentials.md §Local Helper Channel).
// Newline-delimited JSON, one request per connection: `get`/`erase` (git credentials; `repoFullName` routes, the workspace repo folds onto the repo-less key) and `secret` (live secrets, capability-requests.md §4.9.2).
// The per-agent capability (`AgentChannelHolder`) is defense in depth against a shell choosing an agent id, not a host-security boundary; tokens never land on disk.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { GitCredentialCache, GitCredUnavailableError, proxyOnlyRefusal, type CredPlane } from './git-credential.js'
import type { CodeHostProvider, GitCredGrant } from '@agentconnect.md/protocol'
import {
  isProxyOnlyProvider,
  proxyOnlyConsumer,
  type GitCredConsumer,
  type QualifiedCodeHostProvider
} from '../codehost/credentials.js'
import { IMPLICIT_CREDENTIAL_PROVIDER } from '../gitcred/managed-hosts.js'
import { isWindowsNamedPipe, localIpcPath } from '../paths.js'
import {
  DAEMON_SKILL_WINDOW_SUBJECT,
  GITLAB_SKILL_WINDOW_PREFIX,
  SkillCredentialWindows,
  type AdmittedSkillWindow,
  type SkillCredentialWindow
} from './skill-credential-window.js'

// Declared in the `agent-channel/env.ts` leaf, which in-sandbox helpers import without this module's credential cache, and re-exported for daemon-side callers.
export {
  AGENT_CHANNEL_AGENT_ENV,
  AGENT_CHANNEL_CAPABILITY_ENV,
  AGENT_CHANNEL_SOCKET_ENV
} from '../agent-channel/env.js'
import { AGENT_CHANNEL_SOCKET_ENV } from '../agent-channel/env.js'
import { shQuote } from './secrets-shim.js'

/** The socket a helper should dial: an explicit override, else this daemon's own. */
export function agentChannelSocketFrom(env: NodeJS.ProcessEnv, root: string): string {
  const override = env[AGENT_CHANNEL_SOCKET_ENV]?.trim()
  return override && override.length > 0 ? override : agentChannelSocketPath(root)
}

export function agentChannelSocketPath(root: string, platform = process.platform): string {
  return localIpcPath(root, 'agent', platform)
}

export function gitcredShimPath(root: string): string {
  return join(root, 'run', 'git-credential-helper.sh')
}

interface AgentChannelRequest {
  op: 'get' | 'erase' | 'secret'
  agentId: string
  /** Ephemeral daemon-local capability bound to agentId. Never persisted. */
  capability?: string
  password?: string
  /** "owner/repo" to route to (multi-repo, #457); absent ⇒ workspace. */
  repoFullName?: string
  /** 'gh' ⇒ the widened GH_TOKEN capability set; absent/'git' ⇒ contents-only. */
  plane?: string
  /** Host-derived hint from the helper — the provider whose managed host git asked for, absent for
   *  the implicit one. ROUTING ONLY: the daemon's own replicated spec decides the real provider. */
  provider?: string
  /** `secret`: the live secrets wanted by name; absent ⇒ all of them. */
  names?: unknown
}

/** One live secret as the `agentconnect-secrets` helper receives it. */
export interface LiveSecretEntry {
  name: string
  value: string
  description?: string
}

export interface AgentChannelServerDeps {
  log: { info: (m: string) => void; warn: (m: string) => void }
  /** The agent's workspace "owner/repo" label (lowercase-insensitive compare) —
   *  lets a helper request that names the workspace repo share the repo-less
   *  cache key with pre-warm/spawn instead of splitting the cache. */
  workspaceRepoOf?: (agentId: string) => string | undefined
  /** The agent's managed credential provider from its REPLICATED SPEC — never
   *  the helper's claim (§13.2). Absent/undefined ⇒ github (the v1 behavior). */
  providerOf?: (agentId: string) => CodeHostProvider | undefined
  /** The workspace repository's own numeric id from the REPLICATED SPEC — the
   *  §17.1 request identity the grant echo is verified against. */
  workspaceRepoIdOf?: (agentId: string) => string | undefined
  /** A NAMED repository the spec lists as an additional authorization (§8.3) on a host that must be
   *  named on the wire, with its numeric id; undefined when the path is not one. Also from the
   *  replicated spec, so a named repository never introduces a provider the spec lacks. */
  qualifiedRepoOf?: (
    agentId: string,
    repoFullName: string
  ) => { provider: QualifiedCodeHostProvider; externalId: string } | undefined
  /** A NAMED repository the replicated spec lists as a GitHub additional authorization (§8.3) — `qualifiedRepoOf`'s implicit-host twin. */
  githubAdditionalRepoOf?: (agentId: string, repoFullName: string) => boolean
  /** A PRIVATE GitHub skill source the replicated spec enables (shared-skills.md §3): GitHub on any workspace, issued only inside a skill credential window. */
  privateGithubSkillRepoOf?: (agentId: string, repoFullName: string) => boolean
  /** The project id of a credentialed GitLab skill source the replicated spec enables at this path, issued only inside a pod skill window. */
  privateGitlabSkillProjectOf?: (agentId: string, projectPath: string) => string | undefined
  /** The open skill credential windows (source-cache.md §8); absent ⇒ a private registry of this server's own. */
  skillWindows?: SkillCredentialWindows
  /** Whether the agent's spec gives it a managed git credential; every agent holds a capability for live secrets, but only these may `get`. */
  credentialedOf?: (agentId: string) => boolean
  /** The agent's live secrets from the CURRENT in-memory agent, so a value saved a moment ago is served on the next call. */
  liveSecretsOf?: (agentId: string) => readonly LiveSecretEntry[]
}

/** One reply on the agent channel for a `get` or `erase`. */
interface GitCredAnswer {
  ok: boolean
  username?: string
  password?: string
  repoFullName?: string
  /** The grant's tier, for the credential proxy only; never sent to the helper. */
  access?: GitCredGrant['access']
  error?: string
  denied?: 'repository' | 'agent'
}

/** Who a per-agent capability was issued to: the daemon's own git and helpers, or the agent's runtime. */
export type AgentChannelHolder = 'daemon' | 'runtime'

/** What a capability's holder may ask for: `mint` covers `get` and `erase`, `secrets` the live secrets. */
export interface AgentChannelPermissions {
  readonly mint: boolean
  readonly secrets: boolean
}

const FULL_PERMISSIONS: AgentChannelPermissions = { mint: true, secrets: true }
// A runtime holds a placeholder for its code hosts, so its capability keeps only the secrets.
const SECRETS_ONLY_PERMISSIONS: AgentChannelPermissions = { mint: false, secrets: true }

/** Why a capability without `mint` is refused a `get` or an `erase`. */
export const RUNTIME_NO_MINT_ERROR =
  'git and gh reach code hosts through the credential proxy; this credential only serves secrets'

/** An agent capability as an admission sees it: its holder and that holder's permissions. */
interface AgentPrincipal {
  holder: AgentChannelHolder
  permissions: AgentChannelPermissions
}

const isAgentPrincipal = (p: AgentPrincipal | AdmittedSkillWindow): p is AgentPrincipal => 'holder' in p

/** The first line a tunnel proxy sends on an agent channel connection; it carries the server's per-boot key so no pod can forge one. */
const TUNNEL_GREETING_OP = 'via'

export class AgentChannelServer {
  private server?: Server
  private readonly tunnelKey = randomBytes(32).toString('base64url')
  private readonly capabilities = new Map<string, Readonly<Record<AgentChannelHolder, string>>>()
  private readonly log: AgentChannelServerDeps['log']
  private readonly workspaceRepoOf?: (agentId: string) => string | undefined
  private readonly providerOf?: AgentChannelServerDeps['providerOf']
  private readonly workspaceRepoIdOf?: AgentChannelServerDeps['workspaceRepoIdOf']
  private readonly qualifiedRepoOf?: AgentChannelServerDeps['qualifiedRepoOf']
  private readonly githubAdditionalRepoOf?: AgentChannelServerDeps['githubAdditionalRepoOf']
  private readonly privateGithubSkillRepoOf?: AgentChannelServerDeps['privateGithubSkillRepoOf']
  private readonly privateGitlabSkillProjectOf?: AgentChannelServerDeps['privateGitlabSkillProjectOf']
  private readonly credentialedOf?: AgentChannelServerDeps['credentialedOf']
  private readonly liveSecretsOf?: AgentChannelServerDeps['liveSecretsOf']
  readonly skillWindows: SkillCredentialWindows

  constructor(
    private readonly cache: GitCredentialCache,
    private readonly path: string,
    deps: AgentChannelServerDeps
  ) {
    this.log = deps.log
    if (deps.workspaceRepoOf) this.workspaceRepoOf = deps.workspaceRepoOf
    if (deps.providerOf) this.providerOf = deps.providerOf
    if (deps.workspaceRepoIdOf) this.workspaceRepoIdOf = deps.workspaceRepoIdOf
    if (deps.qualifiedRepoOf) this.qualifiedRepoOf = deps.qualifiedRepoOf
    if (deps.githubAdditionalRepoOf) this.githubAdditionalRepoOf = deps.githubAdditionalRepoOf
    if (deps.privateGithubSkillRepoOf) this.privateGithubSkillRepoOf = deps.privateGithubSkillRepoOf
    if (deps.privateGitlabSkillProjectOf) this.privateGitlabSkillProjectOf = deps.privateGitlabSkillProjectOf
    if (deps.credentialedOf) this.credentialedOf = deps.credentialedOf
    if (deps.liveSecretsOf) this.liveSecretsOf = deps.liveSecretsOf
    this.skillWindows = deps.skillWindows ?? new SkillCredentialWindows()
  }

  async start(): Promise<void> {
    const namedPipe = isWindowsNamedPipe(this.path)
    if (!namedPipe) {
      const dir = dirname(this.path)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      try {
        chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
      } catch {
        /* best-effort */
      }
      rmSync(this.path, { force: true })
    }

    const server = createServer((sock) => this.serve(sock))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error) => reject(err)
      server.once('error', onStartupError)
      server.listen(this.path, () => {
        server.off('error', onStartupError)
        server.on('error', (e) => this.log.warn(`agent-channel: socket error: ${e.message}`))
        resolve()
      })
    })
    if (!namedPipe) {
      try {
        chmodSync(this.path, 0o600)
      } catch {
        /* best-effort */
      }
    }
    this.log.info(`agent-channel: helper socket at ${this.path}`)
  }

  stop(): void {
    this.server?.close()
    this.capabilities.clear()
    this.skillWindows.closeAll()
    if (!isWindowsNamedPipe(this.path)) rmSync(this.path, { force: true })
  }

  /** Runtime-only bearer one holder's helper processes present for one agent; both holders' are minted, and revoked, together. */
  capabilityFor(agentId: string, holder: AgentChannelHolder): string {
    let issued = this.capabilities.get(agentId)
    if (!issued) {
      issued = { daemon: randomBytes(32).toString('base64url'), runtime: randomBytes(32).toString('base64url') }
      this.capabilities.set(agentId, issued)
    }
    return issued[holder]
  }

  revoke(agentId: string): void {
    this.capabilities.delete(agentId)
    this.skillWindows.closeAgent(agentId)
  }

  /** A daemon-subject window for one private skill repository; undefined otherwise, so the agent capability keeps its workspace and additional-repository grants. */
  openDaemonSkillWindow(agentId: string, repo: string): SkillCredentialWindow | undefined {
    if (this.privateGithubSkillRepoOf?.(agentId, repo) !== true || this.isGithubWorkspaceRepo(agentId, repo))
      return undefined
    return this.skillWindows.open({ agentId, subject: DAEMON_SKILL_WINDOW_SUBJECT, repos: [repo] })
  }

  /** A pod-subject window for one skill reconcile over the spec's private skill repositories in `repos`; usable only through that pod's tunnel. */
  openPodSkillWindow(agentId: string, subject: string, repos: readonly string[]): SkillCredentialWindow | undefined {
    if (subject === DAEMON_SKILL_WINDOW_SUBJECT) throw new Error('a pod skill window needs a pod subject')
    // The pod's Git child holds only this capability, so the workspace repository is windowed too.
    const admitted = repos.filter((repo) => this.admitsPodSkillRepo(agentId, repo))
    return admitted.length > 0 ? this.skillWindows.open({ agentId, subject, repos: admitted }) : undefined
  }

  /** Whether a pod skill window for this agent would cover `repo`: a GitHub `owner/repo`, or `gitlab:<project path>`. */
  admitsPodSkillRepo(agentId: string, repo: string): boolean {
    if (repo.startsWith(GITLAB_SKILL_WINDOW_PREFIX)) {
      return this.privateGitlabSkillProjectOf?.(agentId, repo.slice(GITLAB_SKILL_WINDOW_PREFIX.length)) !== undefined
    }
    return this.privateGithubSkillRepoOf?.(agentId, repo) === true
  }

  /** The same predicate the workspace fold applies to an implicit-host ask. */
  private isGithubWorkspaceRepo(agentId: string, repo: string): boolean {
    if ((this.providerOf?.(agentId) ?? IMPLICIT_CREDENTIAL_PROVIDER) !== IMPLICIT_CREDENTIAL_PROVIDER) return false
    return this.workspaceRepoOf?.(agentId)?.toLowerCase() === repo.toLowerCase()
  }

  /** The line a tunnel proxy writes before any pod byte, tagging the connection with the pod it serves (source-cache.md §8). */
  tunnelGreeting(subject: string): Buffer {
    return Buffer.from(`${JSON.stringify({ op: TUNNEL_GREETING_OP, subject, key: this.tunnelKey })}\n`, 'utf8')
  }

  private serve(sock: Socket): void {
    let buf = ''
    // undefined until the first line: a greeting names the tunnel's pod, anything else is a daemon-local request.
    let via: string | null | undefined
    let handled = false
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      for (let nl = buf.indexOf('\n'); nl !== -1 && !handled; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (via === undefined) {
          const greeted = this.greetingSubject(line)
          if (greeted === false) {
            handled = true
            sock.end(`${JSON.stringify({ ok: false, error: 'invalid tunnel greeting' })}\n`)
            return
          }
          via = greeted
          if (greeted !== null) continue
        }
        handled = true
        void this.handle(line, sock, via ?? undefined)
      }
    })
    sock.on('error', () => sock.destroy())
  }

  /** The subject a greeting line names, null for a plain request line, false for a forged greeting. */
  private greetingSubject(line: string): string | null | false {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    const value = parsed as { op?: unknown; subject?: unknown; key?: unknown } | null
    if (!value || value.op !== TUNNEL_GREETING_OP) return null
    if (typeof value.subject !== 'string' || value.subject === '' || typeof value.key !== 'string') return false
    const expected = Buffer.from(this.tunnelKey)
    const presented = Buffer.from(value.key)
    return expected.length === presented.length && timingSafeEqual(expected, presented) ? value.subject : false
  }

  private async handle(line: string, sock: Socket, via?: string): Promise<void> {
    const reply = (msg: unknown) => {
      sock.write(JSON.stringify(msg) + '\n')
      sock.end()
    }
    let req: AgentChannelRequest
    try {
      req = JSON.parse(line) as AgentChannelRequest
    } catch {
      return reply({ ok: false, error: 'malformed request' })
    }
    const principal =
      req && typeof req.agentId === 'string' ? this.principalOf(req.agentId, req.capability, via) : undefined
    if (!principal) {
      this.audit('rejected', req?.agentId, req?.plane === 'gh' ? 'gh' : 'git', req?.repoFullName, true)
      return reply({ ok: false, error: 'local credential capability required' })
    }
    if (req.op === 'secret') return this.serveLiveSecrets(req, principal, reply)
    const plane: CredPlane = req.plane === 'gh' ? 'gh' : req.plane === 'glab' ? 'glab' : 'git'
    const repo = typeof req.repoFullName === 'string' && req.repoFullName.includes('/') ? req.repoFullName : undefined
    // An omitted provider and an explicit `github` are the same GitHub ask; both meet the private-skill gate.
    const githubAsk = req.provider === undefined || req.provider === IMPLICIT_CREDENTIAL_PROVIDER
    const privateSkill = repo !== undefined && githubAsk && this.privateGithubSkillRepoOf?.(req.agentId, repo) === true
    // azure-devops-integration.md §6.1: a proxy-only provider's credential is served only to the daemon's own Git on this host, never through a tunnel from inside a boundary.
    if (isAgentPrincipal(principal) && (principal.holder !== 'daemon' || via !== undefined)) {
      const { provider } = this.servedAs(req, repo, privateSkill, undefined)
      if (isProxyOnlyProvider(provider)) {
        const from =
          via === undefined ? `${principal.holder} capability` : `${principal.holder} capability through a tunnel`
        this.audit('denied', req.agentId, plane, repo, true, `${from}, proxy-only provider`)
        return reply({ ok: false, error: proxyOnlyRefusal(provider), denied: 'agent' })
      }
    }
    if (isAgentPrincipal(principal) && !principal.permissions.mint) {
      this.audit(
        'denied',
        req.agentId,
        req.plane === 'gh' ? 'gh' : 'git',
        req.repoFullName,
        true,
        `${principal.holder} capability`
      )
      return reply({ ok: false, error: RUNTIME_NO_MINT_ERROR, denied: 'agent' })
    }
    // Every agent holds a capability for its live secrets; one without a managed git credential is answered as before it had one.
    if (isAgentPrincipal(principal) && this.credentialedOf && !this.credentialedOf(req.agentId)) {
      this.audit('rejected', req.agentId, req.plane === 'gh' ? 'gh' : 'git', req.repoFullName, true)
      return reply({ ok: false, error: 'local credential capability required' })
    }
    // A window capability opens exactly its own private skill repositories on the git plane, nothing else.
    const window = isAgentPrincipal(principal) ? undefined : principal
    // A GitLab skill project is served only through a pod window that names it, read-clamped, by its numeric id.
    if (window && req.provider === 'gitlab' && plane === 'git' && repo !== undefined) {
      return await this.serveGitlabSkillWindow(req, reply, window, repo)
    }
    if (window && (plane !== 'git' || repo === undefined || !privateSkill || !window.covers(repo))) {
      this.audit('denied', req.agentId, plane, repo, true, 'outside skill credential window')
      return reply({
        ok: false,
        error: 'a skill credential window covers only its own private skill repositories',
        denied: 'repository'
      })
    }
    // The daemon's own Git holds the daemon capability; a window opens for a private skill's acquisition.
    const consumer: GitCredConsumer = isAgentPrincipal(principal) && principal.holder === 'daemon' ? 'daemon' : 'helper'
    const { access: _access, ...answer } = await this.answer(req, plane, repo, privateSkill, window, consumer)
    return reply(answer)
  }

  /** The provider an ask is served under and the repository it names after the workspace fold, from the spec alone: the host hint only picks between authorities the spec carries (§13.2, §8.3). */
  private servedAs(
    req: AgentChannelRequest,
    asked: string | undefined,
    privateSkill: boolean,
    window: AdmittedSkillWindow | undefined
  ): {
    repo: string | undefined
    named: ReturnType<NonNullable<AgentChannelServerDeps['qualifiedRepoOf']>>
    provider: CodeHostProvider
  } {
    let repo = asked
    const workspaceProvider = this.providerOf?.(req.agentId) ?? IMPLICIT_CREDENTIAL_PROVIDER
    // The host the REQUEST is for: the helper names every provider but the implicit one.
    const requestProvider: string = req.provider ?? IMPLICIT_CREDENTIAL_PROVIDER
    // A named repository the spec lists on GitHub (private skill source, additional authorization) is GitHub on any workspace; classified before the fold.
    const githubNamed =
      repo !== undefined &&
      requestProvider === IMPLICIT_CREDENTIAL_PROVIDER &&
      (privateSkill || this.githubAdditionalRepoOf?.(req.agentId, repo) === true)
    // The workspace repo folds onto the repo-less key, on its own host only; a window ask stays named, so a window never reaches it.
    if (repo !== undefined && requestProvider === workspaceProvider && !window) {
      const workspace = this.workspaceRepoOf?.(req.agentId)
      if (workspace && workspace.toLowerCase() === repo.toLowerCase()) repo = undefined
    }
    const named = repo !== undefined ? this.qualifiedRepoOf?.(req.agentId, repo) : undefined
    const provider: CodeHostProvider = githubNamed
      ? IMPLICIT_CREDENTIAL_PROVIDER
      : named !== undefined && (req.provider === named.provider || workspaceProvider === named.provider)
        ? named.provider
        : workspaceProvider
    return { repo, named, provider }
  }

  /** What the agent capability, or a window that covers the repository, is served for one admitted ask: the provider from the spec, the workspace fold, then the credential. */
  private async answer(
    req: AgentChannelRequest,
    plane: CredPlane,
    asked: string | undefined,
    privateSkill: boolean,
    window: AdmittedSkillWindow | undefined,
    consumer: GitCredConsumer
  ): Promise<GitCredAnswer> {
    const { repo, named, provider } = this.servedAs(req, asked, privateSkill, window)
    // §6.1: a proxy-only provider's credential is never handed to the agent-facing helper.
    if (consumer === 'helper' && isProxyOnlyProvider(provider)) {
      this.audit('denied', req.agentId, plane, repo, true, 'proxy-only provider')
      return { ok: false, error: proxyOnlyRefusal(provider), denied: 'agent' }
    }
    // Only a provider that is not the implicit one is named on the wire (the empty cache-key segment).
    const qualifier = provider === IMPLICIT_CREDENTIAL_PROVIDER ? {} : { provider }
    if (req.op === 'erase') {
      // Git presents the rejected credential — the provider revokes instantly on
      // uninstall/suspend/rotation, and this is how the daemon cache learns.
      this.cache.invalidate(req.agentId, req.password, {
        plane,
        ...(repo !== undefined ? { repo } : {}),
        ...qualifier
      })
      this.audit('erased', req.agentId, plane, repo)
      return { ok: true }
    }
    if (req.op !== 'get') {
      return { ok: false, error: 'unsupported op' }
    }
    // §8 credential window: the agent capability, which the pod runtime also holds, never mints a private skill token.
    if (!window && privateSkill && repo !== undefined && this.githubAdditionalRepoOf?.(req.agentId, repo) !== true) {
      this.audit('denied', req.agentId, plane, repo, true, 'private skill outside a skill credential window')
      return {
        ok: false,
        error: `${repo} is a private skill source; its token is issued only inside the daemon's skill reconcile`,
        denied: 'repository'
      }
    }
    if (req.provider !== undefined && req.provider !== provider) {
      this.audit('denied', req.agentId, plane, repo)
      return { ok: false, error: `this workspace has no managed ${req.provider} credential` }
    }
    if (plane === 'glab' && provider !== 'gitlab') {
      this.audit('denied', req.agentId, plane, repo)
      return { ok: false, error: 'glab credentials require a managed GitLab workspace' }
    }
    try {
      // §17.1: a qualified ask names the numeric identity its grant echo is verified against: the named repository's, else the workspace's.
      const externalId =
        named?.provider === provider
          ? named.externalId
          : repo === undefined
            ? this.workspaceRepoIdOf?.(req.agentId)
            : undefined
      const cred = await this.cache.get(req.agentId, 'helper', {
        plane,
        ...(repo !== undefined ? { repo } : {}),
        ...qualifier,
        ...(externalId !== undefined ? { externalRepoId: externalId } : {}),
        // §13.3: the CLI wrapper is read-only BY DESIGN — a mutating glab
        // command never receives effect authority and fails at GitLab.
        ...(plane === 'glab' ? { requestedAccess: 'read' as const } : {}),
        ...proxyOnlyConsumer(provider, consumer)
      })
      this.audit('served', req.agentId, plane, repo ?? cred.repoFullName)
      return {
        ok: true,
        username: cred.username,
        password: cred.token,
        repoFullName: cred.repoFullName,
        access: cred.access
      }
    } catch (e) {
      const msg =
        e instanceof GitCredUnavailableError ? e.message : `git credentials unavailable: ${(e as Error).message}`
      this.audit('denied', req.agentId, plane, repo)
      // `denied` tells the helper and the gh wrapper this was a refusal, not an unreachable daemon.
      const denied = e instanceof GitCredUnavailableError ? e.denied : undefined
      return { ok: false, error: msg, ...(denied ? { denied } : {}) }
    }
  }

  /** The agent's live secrets, named ones only when `names` is given; unknown names are simply absent and values are never logged. */
  private serveLiveSecrets(
    req: AgentChannelRequest,
    principal: AgentPrincipal | AdmittedSkillWindow,
    reply: (msg: unknown) => void
  ): void {
    // A skill window opens its private repositories and nothing else.
    if (!isAgentPrincipal(principal)) {
      this.log.warn(`agent-channel: live secrets refused agent=${JSON.stringify(req.agentId)} reason="skill window"`)
      return reply({ ok: false, error: 'a skill credential window carries no live secrets' })
    }
    if (!principal.permissions.secrets) {
      this.log.warn(
        `agent-channel: live secrets refused agent=${JSON.stringify(req.agentId)} reason="${principal.holder} capability"`
      )
      return reply({ ok: false, error: 'this capability carries no live secrets' })
    }
    const wanted = Array.isArray(req.names)
      ? new Set(req.names.filter((n): n is string => typeof n === 'string'))
      : undefined
    const secrets = (this.liveSecretsOf?.(req.agentId) ?? [])
      .filter((s) => wanted === undefined || wanted.has(s.name))
      .map((s) => ({ name: s.name, value: s.value, ...(s.description ? { description: s.description } : {}) }))
    this.log.info(
      `agent-channel: live secrets served agent=${JSON.stringify(req.agentId)} names=${JSON.stringify(secrets.map((s) => s.name))}`
    )
    return reply({ ok: true, secrets })
  }

  /** One GitLab skill project's read credential inside a window that covers it; the op split mirrors the general path. */
  private async serveGitlabSkillWindow(
    req: AgentChannelRequest,
    reply: (msg: unknown) => void,
    window: AdmittedSkillWindow,
    repo: string
  ): Promise<void> {
    const projectId = this.privateGitlabSkillProjectOf?.(req.agentId, repo)
    if (projectId === undefined || !window.covers(`${GITLAB_SKILL_WINDOW_PREFIX}${repo}`)) {
      this.audit('denied', req.agentId, 'git', repo, true, 'outside skill credential window')
      return reply({
        ok: false,
        error: 'a skill credential window covers only its own private skill repositories',
        denied: 'repository'
      })
    }
    // The read PAT on the glab plane, keyed by project path: never the git-plane entry an additional-repository grant may hold writable.
    const key = { plane: 'glab' as const, repo, provider: 'gitlab' as const }
    if (req.op === 'erase') {
      this.cache.invalidate(req.agentId, req.password, key)
      this.audit('erased', req.agentId, 'git', repo)
      return reply({ ok: true })
    }
    if (req.op !== 'get') return reply({ ok: false, error: 'unsupported op' })
    try {
      const cred = await this.cache.get(req.agentId, 'helper', {
        ...key,
        externalRepoId: projectId,
        requestedAccess: 'read',
        consumer: 'daemon'
      })
      this.audit('served', req.agentId, 'git', repo)
      return reply({ ok: true, username: cred.username, password: cred.token, repoFullName: cred.repoFullName })
    } catch (e) {
      const msg =
        e instanceof GitCredUnavailableError ? e.message : `git credentials unavailable: ${(e as Error).message}`
      this.audit('denied', req.agentId, 'git', repo)
      const denied = e instanceof GitCredUnavailableError ? e.denied : undefined
      return reply({ ok: false, error: msg, ...(denied ? { denied } : {}) })
    }
  }

  /** A holder's permissions: the daemon's are full, the runtime's never mint. */
  private permissionsOf(holder: AgentChannelHolder): AgentChannelPermissions {
    return holder === 'runtime' ? SECRETS_ONLY_PERMISSIONS : FULL_PERMISSIONS
  }

  /** Who presented the request: one of the agent's holder capabilities, a live skill window for this agent and this connection's subject, or nobody. */
  private principalOf(
    agentId: string,
    presented?: string,
    via?: string
  ): AgentPrincipal | AdmittedSkillWindow | undefined {
    if (!presented) return undefined
    const issued = this.capabilities.get(agentId)
    if (issued) {
      const b = Buffer.from(presented)
      for (const holder of ['daemon', 'runtime'] as const) {
        const a = Buffer.from(issued[holder])
        if (a.length === b.length && timingSafeEqual(a, b)) return { holder, permissions: this.permissionsOf(holder) }
      }
    }
    // A pod window opens only through its own pod's tunnel; a daemon window only on an untunneled connection.
    return this.skillWindows.admit(agentId, presented, via ?? DAEMON_SKILL_WINDOW_SUBJECT)
  }

  private audit(
    outcome: 'served' | 'erased' | 'denied' | 'rejected',
    agentId: unknown,
    plane: CredPlane,
    repo?: unknown,
    warn = false,
    reason?: string
  ): void {
    const message =
      `agent-channel: local credential outcome=${outcome} agent=${JSON.stringify(agentId)} ` +
      `repo=${JSON.stringify(typeof repo === 'string' ? repo : 'workspace')} plane=${plane}` +
      (reason ? ` reason=${JSON.stringify(reason)}` : '')
    if (warn) this.log.warn(message)
    else this.log.info(message)
  }
}

/**
 * (Re)write the secret-free shim `.git/config` helper lines exec through. The
 * absolute node + CLI paths are re-pinned every daemon boot, so repo configs
 * keep working across upgrades/relocations. Quoted throughout — a home dir
 * with a space (macOS "/Users/example user/…") must not word-split.
 */
export function writeGitcredShim(root: string, cliEntry: string): string {
  const shim = gitcredShimPath(root)
  mkdirSync(dirname(shim), { recursive: true, mode: 0o700 })
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Production runs the built dist (a .js entry node executes directly). A dev
  // daemon runs under tsx with a .ts argv[1] — route the shim through the tsx
  // CLI then, or plain `node entry.ts` would die resolving .js-suffixed imports.
  const argv = [shQuote(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(shQuote(req.resolve('tsx/cli')))
  }
  argv.push(shQuote(executableEntry))
  const body = [
    '#!/bin/sh',
    '# agentconnect git credential helper shim — regenerated on daemon start; NO secrets.',
    `AGENTCONNECT_ROOT=${shQuote(root)} \\`,
    `  exec ${argv.join(' ')} git-credential "$@"`,
    ''
  ].join('\n')
  writeFileSync(shim, body, { mode: 0o755 })
  return shim
}
