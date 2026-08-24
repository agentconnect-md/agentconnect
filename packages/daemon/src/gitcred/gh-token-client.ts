// The gh wrapper's token fetch, independent of WHERE it runs (issue #457).
// One implementation for both entries: the daemon CLI dials its own socket, the in-pod entry dials the shim's tunnel.
// Resolves the TARGET repo with the pure `cp/gh-target.ts` resolver, then proxies gitcred with `plane: 'gh'` —
// the widened GH_TOKEN capability set; caching, coalescing and clamping all live daemon/CP-side.
// Exit codes are the wrapper's contract: 0 = token on stdout, 1 = refused/unreachable (reason on stderr),
// 2 = "not ours" (the target names a non-github.com host), which makes the wrapper run the real gh untouched.
import { execFileSync } from 'node:child_process'
import { resolveGhTargetRepo } from '../cp/gh-target.js'
import { GITCRED_CAPABILITY_ENV } from './env.js'
import { gitcredIpc } from './gh-token-ipc.js'

/** Fetch the token for this gh invocation and print it — nothing else ever reaches stdout. */
export async function emitGhToken(agentId: string, ghArgv: readonly string[], socketPath: string): Promise<void> {
  const target = resolveGhTargetRepo(ghArgv, process.env, cwdOriginRemote)
  if (target.defer) {
    process.exitCode = 2
    return
  }

  const res = await gitcredIpc(socketPath, {
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
