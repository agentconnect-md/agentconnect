/**
 * `agentconnect git-credential <agentId>` — the daemon's entry point to the git credential helper.
 *
 * The helper itself lives in `gitcred/helper.ts`, which knows nothing about daemon paths: the same
 * source also runs inside a sandbox pod, where the socket is one the shim serves rather than one
 * under a daemon root. All this adds is which socket to dial.
 */
import { resolveRoot } from '../paths.js'
import { gitcredSocketFrom } from '../cp/gitcred-server.js'
import { runGitCredential as runHelper } from '../gitcred/helper.js'

export { effectiveAgentId, repoFromPath } from '../gitcred/helper.js'

export async function runGitCredential(action: string, agentId: string): Promise<void> {
  await runHelper(action, agentId, gitcredSocketFrom(process.env, resolveRoot()))
}
