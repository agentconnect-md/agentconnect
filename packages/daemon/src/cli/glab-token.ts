// `agentconnect-daemon glab-token <agentId> -- <glab argv…>` — the DAEMON-side entry of the glab
// wrapper's token fetch (gitlab-com-integration.md §13.3). Nothing but socket selection lives here;
// the fetch, target resolution and exit-code contract are `gitcred/glab-token-client.ts`.
import { emitGlabToken } from '../gitcred/glab-token-client.js'
import { gitcredSocketFrom } from '../cp/gitcred-server.js'
import { resolveRoot } from '../paths.js'

export async function runGlabToken(agentId: string, glabArgv: readonly string[]): Promise<void> {
  await emitGlabToken(agentId, glabArgv, gitcredSocketFrom(process.env, resolveRoot()))
}
