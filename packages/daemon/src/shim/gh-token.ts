#!/usr/bin/env node
// The in-sandbox half of the gh wrapper: `/opt/agentconnect/pathbin/gh` runs this once per `gh` invocation.
// Its own entry for the same reason the credential helper is one — the image copies ONE file per bundle, so two
// entries whose graphs are disjoint stay two single files where a shared module would emit a chunk nothing copies.
// It holds no policy: the daemon decides whether this agent may have a token and for which repository. What
// arrives here is the agent's gh argv and the capability the daemon minted for this launch.
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { emitGhToken } from '../gitcred/gh-token-client.js'
import { SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

async function main(): Promise<number> {
  // `<agentId> -- <gh argv…>`, positional and in that order: the wrapper appends the agent's own argv after `--`.
  const [agentId, ...rest] = process.argv.slice(2)
  if (!agentId) {
    process.stderr.write('agentconnect: gh-token expects <agentId> -- <gh argv…>\n')
    return 2
  }
  const ghArgv = rest[0] === '--' ? rest.slice(1) : rest
  // The tunnel's path unless something names another; a pod has no daemon root to derive one from.
  const socketPath = process.env[GITCRED_SOCKET_ENV]?.trim() || SANDBOX_TUNNEL_PATHS.gitcred
  await emitGhToken(agentId, ghArgv, socketPath)
  // The fetch reports a refusal by setting exitCode, and that has to reach the wrapper: exit 2 makes it run the
  // real gh untouched, so answering 2 for a refusal would silently swap "denied" for "unauthenticated".
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`agentconnect: gh-token failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
)
