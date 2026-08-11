#!/usr/bin/env node
/**
 * The in-sandbox git credential helper. Lives at a fixed path in the runtime image
 * (`/opt/agentconnect/bin/git-credential` wraps it), root-owned and read-only like the shim.
 *
 * Its own entry rather than a mode of the shim, for two reasons that point the same way. Git spawns
 * a credential helper once per operation, and the shim entry pulls in the WebSocket client — a cost
 * and a dependency graph this has no use for. And the image copies ONE file per bundle, so two
 * entries whose graphs are disjoint stay two single files, where a shared module would make
 * rolldown emit a chunk that never gets copied.
 *
 * It holds no policy: the daemon decides whether this agent may have a credential and for which
 * repository. What arrives here is the request git wrote on stdin and the capability the daemon
 * minted for this launch.
 */
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { runGitCredential } from '../gitcred/helper.js'
import { SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

async function main(): Promise<number> {
  // `<agentId> <action>`, positional and in that order: git APPENDS the action to whatever the
  // helper line named, so the id it was configured with comes first.
  const [agentId, action] = process.argv.slice(2)
  if (!action) {
    process.stderr.write('agentconnect: git-credential expects <agentId> <action>\n')
    return 2
  }
  // The tunnel's path unless something names another; a pod has no daemon root to derive one from.
  const socketPath = process.env[GITCRED_SOCKET_ENV]?.trim() || SANDBOX_TUNNEL_PATHS.gitcred
  await runGitCredential(action, agentId ?? '', socketPath)
  // The helper reports a missing credential by setting exitCode, and that has to reach git: a zero
  // exit with no output reads as "this helper has no opinion" rather than as a failure.
  return typeof process.exitCode === 'number' ? process.exitCode : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`agentconnect: git-credential failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
)
