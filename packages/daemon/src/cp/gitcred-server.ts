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
 * `repoFullName` ("owner/repo") routes to that repo's token; absent — or equal
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

// Declared in `gitcred/env.ts` and re-exported here, where every daemon-side caller already looks
// for them: the helper that also runs inside a sandbox cannot import this module (it would pull the
// credential cache into an image whose bundle may import only node builtins).
export { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'

/** The socket a helper should dial: an explicit override, else this daemon's own. */
export function gitcredSocketFrom(env: NodeJS.ProcessEnv, root: string): string {
  const override = env[GITCRED_SOCKET_ENV]?.trim()
  return override && override.length > 0 ? override : gitcredSocketPath(root)
}

export function gitcredSocketPath(root: string): string {
  return join(root, 'run', 'gitcred.sock')
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
  /** Host-derived hint from the helper ('gitlab' when git asked for gitlab.com).
   *  ROUTING ONLY: the daemon's own replicated spec decides the real provider. */
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
  providerOf?: (agentId: string) => 'github' | 'gitlab' | undefined
  /** The gitlab workspace's numeric project id from the REPLICATED SPEC — the
   *  §17.1 request identity the grant echo is verified against. */
  projectIdOf?: (agentId: string) => string | undefined
  /** The numeric project id of a NAMED gitlab project the spec lists as an additional
   *  authorization (§8.3), or undefined when the path is not one. Also from the
   *  replicated spec, so a named project never introduces a provider the spec lacks. */
  gitlabProjectOf?: (agentId: string, repoFullName: string) => string | undefined
}

export class GitCredServer {
  private server?: Server
  private readonly capabilities = new Map<string, string>()
  private readonly log: GitCredServerDeps['log']
  private readonly workspaceRepoOf?: (agentId: string) => string | undefined
  private readonly providerOf?: (agentId: string) => 'github' | 'gitlab' | undefined
  private readonly projectIdOf?: (agentId: string) => string | undefined
  private readonly gitlabProjectOf?: (agentId: string, repoFullName: string) => string | undefined

  constructor(
    private readonly cache: GitCredentialCache,
    private readonly path: string,
    deps: GitCredServerDeps
  ) {
    this.log = deps.log
    if (deps.workspaceRepoOf) this.workspaceRepoOf = deps.workspaceRepoOf
    if (deps.providerOf) this.providerOf = deps.providerOf
    if (deps.projectIdOf) this.projectIdOf = deps.projectIdOf
    if (deps.gitlabProjectOf) this.gitlabProjectOf = deps.gitlabProjectOf
  }

  start(): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700) // defeat a loose umask; best-effort on non-POSIX
    } catch {
      /* best-effort */
    }
    rmSync(this.path, { force: true }) // a stale socket from a crash makes listen() throw

    const server = createServer((sock) => this.serve(sock))
    server.listen(this.path, () => {
      try {
        chmodSync(this.path, 0o600)
      } catch {
        /* best-effort */
      }
      this.log.info(`gitcred: helper socket at ${this.path}`)
    })
    server.on('error', (e) => this.log.warn(`gitcred: socket error: ${e.message}`))
    this.server = server
  }

  stop(): void {
    this.server?.close()
    this.capabilities.clear()
    rmSync(this.path, { force: true })
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
  }

  private serve(sock: Socket): void {
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      void this.handle(line, sock)
    })
    sock.on('error', () => sock.destroy())
  }

  private async handle(line: string, sock: Socket): Promise<void> {
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
    if (!req || typeof req.agentId !== 'string' || !this.authorized(req.agentId, req.capability)) {
      this.audit('rejected', req?.agentId, req?.plane === 'gh' ? 'gh' : 'git', req?.repoFullName, true)
      return reply({ ok: false, error: 'local credential capability required' })
    }
    const plane: CredPlane = req.plane === 'gh' ? 'gh' : req.plane === 'glab' ? 'glab' : 'git'
    // Workspace normalization: a request naming the workspace repo folds onto
    // the repo-less key (one cache entry with pre-warm/spawn; and old CPs that
    // strip the wire field keep serving the workspace unchanged).
    let repo = typeof req.repoFullName === 'string' && req.repoFullName.includes('/') ? req.repoFullName : undefined
    if (repo !== undefined) {
      const workspace = this.workspaceRepoOf?.(req.agentId)
      if (workspace && workspace.toLowerCase() === repo.toLowerCase()) repo = undefined
    }
    if (req.op === 'erase') {
      // Git presents the rejected credential — the provider revokes instantly on
      // uninstall/suspend/rotation, and this is how the daemon cache learns. The
      // SPEC-derived provider keys the entry, exactly as the get stored it.
      const eraseProvider = this.providerOf?.(req.agentId) ?? 'github'
      this.cache.invalidate(req.agentId, req.password, {
        plane,
        ...(repo !== undefined ? { repo } : {}),
        ...(eraseProvider === 'gitlab' ? { provider: 'gitlab' as const } : {})
      })
      this.audit('erased', req.agentId, plane, repo)
      return reply({ ok: true })
    }
    if (req.op !== 'get') {
      return reply({ ok: false, error: 'unsupported op' })
    }
    // The SPEC decides the provider; a helper whose host hint disagrees is
    // asking for another host's credential and gets a clean denial (§13.2).
    // A named project the spec lists as a gitlab additional authorization (§8.3) is
    // the second spec-derived gitlab authority; the host hint only disambiguates
    // between authorities the spec already carries, it never introduces one.
    const workspaceProvider = this.providerOf?.(req.agentId) ?? 'github'
    const gitlabProject = repo !== undefined ? this.gitlabProjectOf?.(req.agentId, repo) : undefined
    const provider: 'github' | 'gitlab' =
      gitlabProject !== undefined && (req.provider === 'gitlab' || workspaceProvider === 'gitlab')
        ? 'gitlab'
        : workspaceProvider
    if (req.provider !== undefined && req.provider !== provider) {
      this.audit('denied', req.agentId, plane, repo)
      return reply({ ok: false, error: `this workspace has no managed ${req.provider} credential` })
    }
    if (plane === 'glab' && provider !== 'gitlab') {
      this.audit('denied', req.agentId, plane, repo)
      return reply({ ok: false, error: 'glab credentials require a managed GitLab workspace' })
    }
    try {
      // §17.1: every gitlab ask names the rename-stable numeric identity so the
      // consumer can reject a wrong-project grant echo — the workspace project for
      // the repo-less ask, the authorized project for a named one. Without it a
      // named project resolves to the workspace grant and the echo check rejects it.
      const projectId =
        provider !== 'gitlab'
          ? undefined
          : (gitlabProject ?? (repo === undefined ? this.projectIdOf?.(req.agentId) : undefined))
      const cred = await this.cache.get(req.agentId, 'helper', {
        plane,
        ...(repo !== undefined ? { repo } : {}),
        ...(provider === 'gitlab' ? { provider: 'gitlab' as const } : {}),
        ...(projectId !== undefined ? { externalRepoId: projectId } : {}),
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
      return reply({ ok: false, error: msg })
    }
  }

  private authorized(agentId: string, presented?: string): boolean {
    const expected = this.capabilities.get(agentId)
    if (!expected || !presented) return false
    const a = Buffer.from(expected)
    const b = Buffer.from(presented)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private audit(
    outcome: 'served' | 'erased' | 'denied' | 'rejected',
    agentId: unknown,
    plane: CredPlane,
    repo?: unknown,
    warn = false
  ): void {
    const message =
      `gitcred: local credential outcome=${outcome} agent=${JSON.stringify(agentId)} ` +
      `repo=${JSON.stringify(typeof repo === 'string' ? repo : 'workspace')} plane=${plane}`
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
  const q = (v: string) => `'${v.replaceAll("'", "'\\''")}'`
  const executableEntry = existsSync(cliEntry) ? realpathSync(cliEntry) : cliEntry
  // Production runs the built dist (a .js entry node executes directly). A dev
  // daemon runs under tsx with a .ts argv[1] — route the shim through the tsx
  // CLI then, or plain `node entry.ts` would die resolving .js-suffixed imports.
  const argv = [q(realpathSync(process.execPath))]
  if (executableEntry.endsWith('.ts')) {
    const req = createRequire(import.meta.url)
    argv.push(q(req.resolve('tsx/cli')))
  }
  argv.push(q(executableEntry))
  const body = [
    '#!/bin/sh',
    '# agentconnect git credential helper shim — regenerated on daemon start; NO secrets.',
    `AGENTCONNECT_ROOT=${q(root)} \\`,
    `  exec ${argv.join(' ')} git-credential "$@"`,
    ''
  ].join('\n')
  writeFileSync(shim, body, { mode: 0o755 })
  return shim
}
