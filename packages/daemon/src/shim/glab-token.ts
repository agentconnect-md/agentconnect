#!/usr/bin/env node
// The in-sandbox half of the glab wrapper (gitlab-com-integration.md §13.3): gh-token's twin, its own single-file bundle, no policy of its own.
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { emitGlabToken } from '../gitcred/glab-token-client.js'
import { SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

async function main(): Promise<number> {
  // `<agentId> -- <glab argv…>`, positional and in that order: the wrapper appends the agent's own argv after `--`.
  const [agentId, ...rest] = process.argv.slice(2)
  if (!agentId) {
    process.stderr.write('agentconnect: glab-token expects <agentId> -- <glab argv…>\n')
    return 2
  }
  const glabArgv = rest[0] === '--' ? rest.slice(1) : rest
  const socketPath = process.env[GITCRED_SOCKET_ENV]?.trim() || SANDBOX_TUNNEL_PATHS.gitcred
  await emitGlabToken(agentId, glabArgv, socketPath)
  // A refusal sets exitCode 1; answering 2 would make the wrapper run glab unauthenticated instead.
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`agentconnect: glab-token failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
)
