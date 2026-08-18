/**
 * `agentconnect gh-token <agentId> -- <gh argv…>` — the gh wrapper's token fetch
 * (agent-multi-repo-authorization.md decision 4, issue #457).
 *
 * Receives the agent's whole `gh` argv, resolves the TARGET repo with the pure
 * `cp/gh-target.ts` resolver (flag → command-carried target → `GH_REPO` → cwd origin),
 * and prints a fresh installation token for it — or for the agent's workspace repo when
 * nothing names one — to STDOUT; nothing else ever lands there. Proxies gitcred.sock
 * with the runtime-only agent capability and `plane: 'gh'` (the widened GH_TOKEN
 * capability set); caching/coalescing/clamping all live daemon/CP-side.
 *
 * Exit codes (the wrapper's contract):
 *   0 — token on stdout
 *   1 — daemon refused / unreachable (actionable reason on stderr; the wrapper
 *       lets gh try its own configured auth)
 *   2 — "not ours": the target names a non-github.com host — the wrapper runs the
 *       real gh untouched
 */
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolveRoot } from '../paths.js'
import { GITCRED_CAPABILITY_ENV, gitcredSocketFrom } from '../cp/gitcred-server.js'
import { resolveGhTargetRepo } from '../cp/gh-target.js'

export async function runGhToken(agentId: string, ghArgv: readonly string[]): Promise<void> {
  const target = resolveGhTargetRepo(ghArgv, process.env, cwdOriginRemote)
  if (target.defer) {
    process.exitCode = 2
    return
  }

  const res = await ipc({
    op: 'get',
    agentId,
    capability: process.env[GITCRED_CAPABILITY_ENV],
    plane: 'gh',
    repoFullName: target.repo
  })
  if (!res.ok || !res.password) {
    process.stderr.write(
      `agentconnect: no gh credentials for agent ${agentId}${target.repo ? ` on ${target.repo}` : ''}: ${res.error ?? 'unknown error'}\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(res.password)
}

/** The last-resort target: the origin remote of the directory the agent ran gh in. */
function cwdOriginRemote(): string | undefined {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim() || undefined
  } catch {
    return undefined
  }
}

interface IpcReply {
  ok: boolean
  password?: string
  error?: string
}

function ipc(msg: unknown): Promise<IpcReply> {
  const path = gitcredSocketFrom(process.env, resolveRoot())
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
