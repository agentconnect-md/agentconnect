/**
 * gitcred.sock — the local credential channel for agent-run git AND gh
 * (docs/designs/github-app-git-credentials.md §Local Helper Channel;
 * agent-multi-repo-authorization.md §Daemon for per-repo routing, #457).
 *
 * A tiny newline-delimited-JSON server over a unix socket (0700 dir + 0600
 * socket, stale-socket cleanup — the `mcp/control-server.ts` pattern). Hidden
 * helper subcommands connect per invocation with a runtime-only, per-agent
 * capability:
 *   { op: 'get',   agentId, capability, repoFullName?, plane? }  → { ok, username, password } | { ok:false, error }
 *   { op: 'erase', agentId, capability, password?, repoFullName?, plane? } → { ok: true }
 *
 * `repoFullName` ("owner/repo") routes to that repo's token; absent — or equal, on the workspace's own host,
 * to the agent's workspace repo, which is NORMALIZED onto the repo-less key so
 * the helper path and the pre-warm/spawn paths share one cache entry — ⇒ the
 * workspace token. `plane: 'gh'` picks the widened GH_TOKEN capability set.
 *
 * The capability prevents a shell process from selecting an agent id and
 * directly querying the socket. It is defense in depth, not a host-security
 * boundary: a same-user process that can inspect or modify the managed runtime
 * can still recover it. Repo authorization remains the CP's decision. Tokens
 * transit the socket and helper stdout only; nothing lands on disk.
 *
 * Alongside the socket the daemon (re)writes SECRET-FREE files per boot:
 * the shim `run/git-credential-helper.sh` (pins the current node + CLI path so
 * `.git/config` survives daemon upgrades), the `run/bin/gh` wrapper (see
 * cp/gh-shim.ts) and per-agent gitconfig includes for the session-env channel
 * (see workspace/git-injection.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { GitCredentialCache, GitCredUnavailableError, type CredPlane } from './git-credential.js'
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { QualifiedCodeHostProvider } from '../codehost/credentials.js'
import { IMPLICIT_CREDENTIAL_PROVIDER } from '../gitcred/managed-hosts.js'
import { isWindowsNamedPipe, localIpcPath } from '../paths.js'
import {
  DAEMON_SKILL_WINDOW_SUBJECT,
  SkillCredentialWindows,
  type AdmittedSkillWindow,
  type SkillCredentialWindow
} from './skill-credential-window.js'

// Declared in `gitcred/env.ts` and re-exported here, where every daemon-side caller already looks
// for them: the helper that also runs inside a sandbox cannot import this module (it would pull the
// credential cache into an image whose bundle may import only node builtins).
export { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { shQuote } from './gh-shim.js'

/** The socket a helper should dial: an explicit override, else this daemon's own. */
export function gitcredSocketFrom(env: NodeJS.ProcessEnv, root: string): string {
  const override = env[GITCRED_SOCKET_ENV]?.trim()
  return override && override.length > 0 ? override : gitcredSocketPath(root)
}

export function gitcredSocketPath(root: string, platform = process.platform): string {
  return localIpcPath(root, 'gitcred', platform)
}

export function gitcredShimPath(root: string): string {
  return join(root, 'run', 'git-credential-helper.sh')
}

interface GitCredIpcRequest {
  op: 'get' | 'erase'
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
}

export interface GitCredServerDeps {
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
  /** The open skill credential windows (source-cache.md §8); absent ⇒ a private registry of this server's own. */
  skillWindows?: SkillCredentialWindows
}

/** The first line a tunnel proxy sends on a gitcred connection; it carries the server's per-boot key so no pod can forge one. */
const TUNNEL_GREETING_OP = 'via'

export class GitCredServer {
  private server?: Server
  private readonly tunnelKey = randomBytes(32).toString('base64url')
  private readonly capabilities = new Map<string, string>()
  private readonly log: GitCredServerDeps['log']
  private readonly workspaceRepoOf?: (agentId: string) => string | undefined
  private readonly providerOf?: GitCredServerDeps['providerOf']
  private readonly workspaceRepoIdOf?: GitCredServerDeps['workspaceRepoIdOf']
  private readonly qualifiedRepoOf?: GitCredServerDeps['qualifiedRepoOf']
  private readonly githubAdditionalRepoOf?: GitCredServerDeps['githubAdditionalRepoOf']
  private readonly privateGithubSkillRepoOf?: GitCredServerDeps['privateGithubSkillRepoOf']
  readonly skillWindows: SkillCredentialWindows

  constructor(
    private readonly cache: GitCredentialCache,
    private readonly path: string,
    deps: GitCredServerDeps
  ) {
    this.log = deps.log
    if (deps.workspaceRepoOf) this.workspaceRepoOf = deps.workspaceRepoOf
    if (deps.providerOf) this.providerOf = deps.providerOf
    if (deps.workspaceRepoIdOf) this.workspaceRepoIdOf = deps.workspaceRepoIdOf
    if (deps.qualifiedRepoOf) this.qualifiedRepoOf = deps.qualifiedRepoOf
    if (deps.githubAdditionalRepoOf) this.githubAdditionalRepoOf = deps.githubAdditionalRepoOf
    if (deps.privateGithubSkillRepoOf) this.privateGithubSkillRepoOf = deps.privateGithubSkillRepoOf
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
        server.on('error', (e) => this.log.warn(`gitcred: socket error: ${e.message}`))
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
    this.log.info(`gitcred: helper socket at ${this.path}`)
  }

  stop(): void {
    this.server?.close()
    this.capabilities.clear()
    this.skillWindows.closeAll()
    if (!isWindowsNamedPipe(this.path)) rmSync(this.path, { force: true })
  }

  /** Runtime-only bearer used by the helper processes for one agent. */
  capabilityFor(agentId: string): string {
    let capability = this.capabilities.get(agentId)
    if (!capability) {
      capability = randomBytes(32).toString('base64url')
      this.capabilities.set(agentId, capability)
    }
    return capability
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

  /** Whether a pod skill window for this agent would cover `repo`. */
  admitsPodSkillRepo(agentId: string, repo: string): boolean {
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
    let req: GitCredIpcRequest
    try {
      req = JSON.parse(line) as GitCredIpcRequest
    } catch {
      return reply({ ok: false, error: 'malformed request' })
    }
    const principal =
      req && typeof req.agentId === 'string' ? this.principalOf(req.agentId, req.capability, via) : undefined
    if (!principal) {
      this.audit('rejected', req?.agentId, req?.plane === 'gh' ? 'gh' : 'git', req?.repoFullName, true)
      return reply({ ok: false, error: 'local credential capability required' })
    }
    const plane: CredPlane = req.plane === 'gh' ? 'gh' : req.plane === 'glab' ? 'glab' : 'git'
    let repo = typeof req.repoFullName === 'string' && req.repoFullName.includes('/') ? req.repoFullName : undefined
    // An omitted provider and an explicit `github` are the same GitHub ask; both meet the private-skill gate.
    const githubAsk = req.provider === undefined || req.provider === IMPLICIT_CREDENTIAL_PROVIDER
    const privateSkill = repo !== undefined && githubAsk && this.privateGithubSkillRepoOf?.(req.agentId, repo) === true
    // A window capability opens exactly its own private skill repositories on the git plane, nothing else.
    const window = principal === 'agent' ? undefined : principal
    if (window && (plane !== 'git' || repo === undefined || !privateSkill || !window.covers(repo))) {
      this.audit('denied', req.agentId, plane, repo, true, 'outside skill credential window')
      return reply({
        ok: false,
        error: 'a skill credential window covers only its own private skill repositories',
        denied: 'repository'
      })
    }
    // The SPEC decides the provider; a helper whose host hint disagrees is
    // asking for another host's credential and gets a clean denial (§13.2).
    // A named repository the spec lists as an additional authorization on another host (§8.3) is the
    // second spec-derived authority; the host hint only disambiguates between authorities the spec
    // already carries, it never introduces one.
    //
    // Resolved BEFORE the op split: erase has to reach the key get stored, and an additional
    // repository on another host rides a scratch or github workspace whose spec alone says github.
    // Deriving erase from the workspace would invalidate the wrong entry and leave the rejected
    // token live to TTL.
    const workspaceProvider = this.providerOf?.(req.agentId) ?? IMPLICIT_CREDENTIAL_PROVIDER
    // The host the REQUEST is for: the helper names every provider but the implicit one.
    const requestProvider: string = req.provider ?? IMPLICIT_CREDENTIAL_PROVIDER
    // A named repository the spec lists on GitHub (private skill source, additional authorization) is GitHub on any workspace; classified before the fold.
    const githubNamed =
      repo !== undefined &&
      requestProvider === IMPLICIT_CREDENTIAL_PROVIDER &&
      (privateSkill || this.githubAdditionalRepoOf?.(req.agentId, repo) === true)
    // Workspace normalization: a request naming the workspace repo folds onto
    // the repo-less key (one cache entry with pre-warm/spawn; and old CPs that
    // strip the wire field keep serving the workspace unchanged) — only when the
    // ask is for the workspace's own host. The same path on another host is
    // another repository, never the workspace.
    // A window ask stays named, so a window never reaches the workspace key.
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
      return reply({ ok: true })
    }
    if (req.op !== 'get') {
      return reply({ ok: false, error: 'unsupported op' })
    }
    // §8 credential window: the agent capability, which the pod runtime also holds, never mints a private skill token.
    if (!window && privateSkill && repo !== undefined && this.githubAdditionalRepoOf?.(req.agentId, repo) !== true) {
      this.audit('denied', req.agentId, plane, repo, true, 'private skill outside a skill credential window')
      return reply({
        ok: false,
        error: `${repo} is a private skill source; its token is issued only inside the daemon's skill reconcile`,
        denied: 'repository'
      })
    }
    if (req.provider !== undefined && req.provider !== provider) {
      this.audit('denied', req.agentId, plane, repo)
      return reply({ ok: false, error: `this workspace has no managed ${req.provider} credential` })
    }
    if (plane === 'glab' && provider !== 'gitlab') {
      this.audit('denied', req.agentId, plane, repo)
      return reply({ ok: false, error: 'glab credentials require a managed GitLab workspace' })
    }
    try {
      // §17.1: every qualified ask names the rename-stable numeric identity so the consumer can
      // reject a wrong-repository grant echo — the authorized repository for a named ask, the
      // workspace's own for the repo-less one. Without it a named repository resolves to the
      // workspace grant and the echo check rejects it.
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
        ...(plane === 'glab' ? { requestedAccess: 'read' as const } : {})
      })
      this.audit('served', req.agentId, plane, repo ?? cred.repoFullName)
      return reply({ ok: true, username: cred.username, password: cred.token, repoFullName: cred.repoFullName })
    } catch (e) {
      const msg =
        e instanceof GitCredUnavailableError ? e.message : `git credentials unavailable: ${(e as Error).message}`
      this.audit('denied', req.agentId, plane, repo)
      // `denied` tells the helper and the gh wrapper this was a refusal, not an unreachable daemon.
      const denied = e instanceof GitCredUnavailableError ? e.denied : undefined
      return reply({ ok: false, error: msg, ...(denied ? { denied } : {}) })
    }
  }

  /** Who presented the request: the agent capability, a live skill window for this agent and this connection's subject, or nobody. */
  private principalOf(agentId: string, presented?: string, via?: string): 'agent' | AdmittedSkillWindow | undefined {
    if (!presented) return undefined
    const expected = this.capabilities.get(agentId)
    if (expected) {
      const a = Buffer.from(expected)
      const b = Buffer.from(presented)
      if (a.length === b.length && timingSafeEqual(a, b)) return 'agent'
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
      `gitcred: local credential outcome=${outcome} agent=${JSON.stringify(agentId)} ` +
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
