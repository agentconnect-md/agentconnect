// The glab wrapper's token fetch (gitlab-com-integration.md §13.3), independent of WHERE it runs.
// Resolves the TARGET project with the pure `cp/glab-target.ts` resolver, then proxies gitcred with
// `plane: 'glab'` — the daemon serves the binding's READ credential only, so a mutating glab command
// never receives effect authority and fails at GitLab. Exit codes are the wrapper's contract:
// 0 = token on stdout, 1 = refused/unreachable (reason on stderr), 2 = "not ours" (non-gitlab host).
import { execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolveGlabTargetProject } from '../cp/glab-target.js'
import { GITCRED_CAPABILITY_ENV } from './env.js'

/** Fetch the read token for this glab invocation and print it — nothing else ever reaches stdout. */
export async function emitGlabToken(agentId: string, glabArgv: readonly string[], socketPath: string): Promise<void> {
  const target = resolveGlabTargetProject(glabArgv, process.env, cwdOriginRemote)
  if (target.defer) {
    process.exitCode = 2
    return
  }

  const res = await ipc(socketPath, {
    op: 'get',
    agentId,
    capability: process.env[GITCRED_CAPABILITY_ENV],
    plane: 'glab',
    provider: 'gitlab',
    repoFullName: target.project
  })
  if (!res.ok || !res.password) {
    process.stderr.write(
      `agentconnect: no glab credentials for agent ${agentId}${target.project ? ` on ${target.project}` : ''}: ${res.error ?? 'unknown error'}\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(res.password)
}

/** The last-resort target: the origin remote of the directory the agent ran glab in. */
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
