/**
 * `agentconnect gh-token <agentId> [repo]` — the gh wrapper's token fetch
 * (agent-multi-repo-authorization.md decision 4, issue #457).
 *
 * Prints a fresh installation token for the named repo (or the agent's
 * workspace repo when none is given) to STDOUT — nothing else ever lands
 * there. Proxies gitcred.sock with the runtime-only agent capability and
 * `plane: 'gh'` (the widened GH_TOKEN capability set);
 * caching/coalescing/clamping all live daemon/CP-side.
 *
 * Exit codes (the wrapper's contract):
 *   0 — token on stdout
 *   1 — daemon refused / unreachable (actionable reason on stderr; the wrapper
 *       lets gh try its own configured auth)
 *   2 — "not ours": the repo argument names a non-github.com host — the
 *       wrapper runs the real gh untouched
 */
import { createConnection } from 'node:net'
import { gitRepoLabel } from '@agentconnect.md/protocol'
import { resolveRoot } from '../paths.js'
import { GITCRED_CAPABILITY_ENV, gitcredSocketPath } from '../cp/gitcred-server.js'

export async function runGhToken(agentId: string, repoRaw?: string): Promise<void> {
  const target = normalizeRepoArg(repoRaw)
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

/**
 * Normalize the wrapper's raw repo argument. gh accepts `OWNER/REPO`,
 * `HOST/OWNER/REPO` and full URLs for `-R`/`GH_REPO`; the cwd fallback hands
 * us whatever `git remote get-url origin` prints. Unparseable ⇒ workspace
 * token (repo undefined); a clearly non-github.com target ⇒ defer (the
 * wrapper runs the real gh untouched — `gitRepoLabel` strips ANY host, so
 * the github.com assertion lives here).
 */
export function normalizeRepoArg(raw?: string): { repo?: string; defer?: boolean } {
  const s = raw?.trim()
  if (!s) return {}
  // Bare OWNER/REPO (no host, no scheme).
  if (/^[^/\s:@]+\/[^/\s:@]+$/.test(s)) return { repo: s.replace(/\.git$/i, '') }
  // Full URL (https://git.example.com/…) or scp form (git@git.example.com:…).
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(s)?.[1] ?? /^[\w.-]+@([\w.-]+):/.exec(s)?.[1]
  if (host) {
    if (host.toLowerCase() !== 'github.com') return { defer: true }
    const segs = gitRepoLabel(s).split('/')
    return segs.length >= 2 && segs[0] && segs[1] ? { repo: `${segs[0]}/${segs[1]}` } : {}
  }
  // HOST/OWNER/REPO plain form (gh's own shape).
  const segs = s.split('/')
  if (segs.length === 3 && segs[0]!.includes('.')) {
    if (segs[0]!.toLowerCase() !== 'github.com') return { defer: true }
    return { repo: `${segs[1]}/${segs[2]!.replace(/\.git$/i, '')}` }
  }
  return {}
}

interface IpcReply {
  ok: boolean
  password?: string
  error?: string
}

function ipc(msg: unknown): Promise<IpcReply> {
  const path = gitcredSocketPath(resolveRoot())
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
