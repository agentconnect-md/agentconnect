// `agentconnect gh-token <agentId> -- <gh argv…>` — the DAEMON-side entry of the gh wrapper's token fetch (#457).
// Nothing but socket selection lives here: an explicit AC_GITCRED_SOCKET, else this daemon's own root.
// The fetch, the target-repo resolution and the exit-code contract are `gitcred/gh-token-client.ts`, shared with
// the in-sandbox entry so a pod agent and a self-hosted one cannot answer the same `gh` differently.
import { emitGhToken } from '../gitcred/gh-token-client.js'
import { gitcredSocketFrom } from '../cp/gitcred-server.js'
import { resolveRoot } from '../paths.js'

export async function runGhToken(agentId: string, ghArgv: readonly string[]): Promise<void> {
  await emitGhToken(agentId, ghArgv, gitcredSocketFrom(process.env, resolveRoot()))
}
