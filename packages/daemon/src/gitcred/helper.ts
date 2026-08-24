/**
 * The git credential helper itself (docs/designs/github-app-git-credentials.md §Local Helper
 * Channel), independent of where it runs.
 *
 * Speaks git's credential-helper protocol on stdin/stdout and proxies to a gitcred socket with the
 * runtime-only agent capability; the token exists only on the reply pipe. Actions:
 *   get   → username=x-access-token / password=<token>   (host must be github.com)
 *   erase → forward to the daemon (invalidate the cached token git just had rejected)
 *   store → no-op
 *
 * The `path` git sends (useHttpPath=true is part of the injection) ROUTES the
 * request since issue #457: it is parsed to "owner/repo" and forwarded, so an
 * authorized non-workspace repo gets ITS token (multi-repo design decision 5).
 * Path absent/unparseable ⇒ the workspace token, the pre-#457 behavior. This
 * is routing, not authorization — the CP gate decides; token scope enforces
 * the real boundary at GitHub either way.
 *
 * WHICH hosts are ours comes from the injected table (§24.4), never from two literals and never
 * from the agent's own environment as a hint: the daemon writes it beside the capability at
 * injection time, each entry carrying the full base URL, so a prefixed install's path prefix is
 * stripped before the project path is parsed.
 *
 * Exit style: on ANY failure print a human-actionable line to stderr and exit 1
 * — since #251 surfaces turn failures to end users, this text is user-facing.
 * NEVER print or log the token outside the protocol response.
 *
 * WHICH socket to dial is the caller's business, and that is the whole reason this is a leaf: the
 * daemon CLI derives it from its own root, while in a sandbox pod the same code dials the path the
 * shim serves the daemon's socket on. Its only imports are node builtins and the env names, because
 * the in-sandbox bundle is asserted to import nothing else.
 */
import { createConnection } from 'node:net'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from './env.js'
import { decodeManagedHostTable, GITCRED_HOSTS_ENV, matchManagedHost } from './managed-hosts.js'

interface HelperInput {
  protocol?: string
  host?: string
  path?: string
  password?: string
}

/**
 * The argv id comes from a config file (`.git/config` helper line) that can
 * outlive the agent that wrote it — deleted + recreated under the same name,
 * the checkout survives with the DEAD id and the daemon denies every request.
 * The env identity is minted together with the capability at spawn/clone
 * (gitCredentialEnv), so when present it names the agent actually invoking
 * git and always matches the capability sent beside it.
 */
export function effectiveAgentId(argvAgentId: string): string {
  return process.env[GITCRED_AGENT_ENV] || argvAgentId
}

export async function runGitCredential(action: string, agentId: string, socketPath: string): Promise<void> {
  if (action === 'store') return // git offers the accepted credential back — nothing to do

  agentId = effectiveAgentId(agentId)

  const input = parseStdin(await readStdin())
  const match = matchManagedHost(decodeManagedHostTable(process.env[GITCRED_HOSTS_ENV]), input)
  // GitLab keeps full subgroup depth from the instance's path prefix (§13.2); github stays owner/repo.
  const gitlab = match?.entry.provider === 'gitlab'
  const repo = match?.path === undefined ? undefined : gitlab ? projectFromPath(match.path) : repoFromPath(match.path)

  // Not ours — stay silent so git can try other helpers; an absent host still means the workspace.
  if (input.host !== undefined && match === undefined) return

  if (action === 'erase') {
    // Route the invalidation to the same (agent, repo) key the get used.
    await ipc(socketPath, {
      op: 'erase',
      agentId,
      capability: process.env[GITCRED_CAPABILITY_ENV],
      password: input.password,
      repoFullName: repo,
      ...(gitlab ? { provider: 'gitlab' } : {})
    }).catch(() => undefined) // best-effort
    return
  }
  if (action !== 'get') return // unknown actions are ignored per the helper contract

  const res = await ipc(socketPath, {
    op: 'get',
    agentId,
    capability: process.env[GITCRED_CAPABILITY_ENV],
    repoFullName: repo,
    ...(gitlab ? { provider: 'gitlab' } : {})
  })
  if (!res.ok || !res.username || !res.password) {
    process.stderr.write(
      `agentconnect: no git credentials for agent ${agentId}${repo ? ` on ${repo}` : ''}: ${res.error ?? 'unknown error'}\n` +
        `(the daemon must be running and connected to the control plane)\n`
    )
    process.exitCode = 1
    return
  }
  // Diagnostics-only sanity (the daemon guard already refuses cross-repo
  // grants): a mismatch here means an old daemon answered with the workspace
  // token — GitHub's single-repo token scope still enforces the boundary.
  if (repo !== undefined) {
    const want = normalizeRepoPath(res.repoFullName ?? '')
    if (want && want !== repo) {
      process.stderr.write(
        `agentconnect: note — git asked for ${repo} but the daemon answered for ${want} ` +
          `(daemon predates per-repo credentials?)\n`
      )
    }
  }
  process.stdout.write(`username=${res.username}\npassword=${res.password}\n`)
}

function normalizeRepoPath(p: string): string {
  return p
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

/** The full namespaced GitLab project path from git's credential `path` —
 *  arbitrary subgroup depth, tolerating a leading slash, a `.git` suffix, and
 *  LFS-ish subpaths (`group/sub/project.git/info/lfs`). */
export function projectFromPath(p: string): string | undefined {
  const cleaned = p.replace(/^\/+/, '')
  const gitSuffix = cleaned.search(/\.git(?:\/|$)/i)
  const path = (gitSuffix >= 0 ? cleaned.slice(0, gitSuffix) : cleaned).replace(/\/+$/, '')
  return path.includes('/') ? path.toLowerCase() : undefined
}

/** "owner/repo" from git's credential `path` — tolerates a leading slash, a
 *  `.git` suffix, and LFS-ish subpaths (`owner/repo.git/info/lfs`). */
export function repoFromPath(p: string): string | undefined {
  const segs = p.replace(/^\/+/, '').split('/')
  const owner = segs[0]
  const repo = segs[1]?.replace(/\.git$/i, '')
  if (!owner || !repo) return undefined
  return `${owner}/${repo}`.toLowerCase()
}

function parseStdin(text: string): HelperInput {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return out
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (buf += c))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', () => resolve(buf))
  })
}

interface IpcReply {
  ok: boolean
  username?: string
  password?: string
  repoFullName?: string
  error?: string
}

function ipc(path: string, msg: unknown): Promise<IpcReply> {
  return new Promise((resolve) => {
    const sock = createConnection(path)
    let buf = ''
    const fail = (error: string) => resolve({ ok: false, error })
    sock.setTimeout(15_000, () => {
      sock.destroy()
      fail('daemon did not answer in time')
    })
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      sock.destroy()
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as IpcReply)
      } catch {
        fail('malformed daemon reply')
      }
    })
    sock.on('error', (e) => fail(`cannot reach the daemon socket at ${path}: ${e.message}`))
  })
}
