// `agentconnect-daemon secrets <command…>` — the DAEMON-side entry of `agentconnect-secrets` (capability-requests.md §4.9.2); the helper is `agent-channel/secrets-client.ts`.
import { agentChannelSocketFrom } from '../cp/agent-channel-server.js'
import { resolveRoot } from '../paths.js'
import { runSecretsHelper } from '../agent-channel/secrets-client.js'

export async function runSecrets(argv: readonly string[]): Promise<number> {
  return await runSecretsHelper(argv, {
    socketPath: agentChannelSocketFrom(process.env, resolveRoot()),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  })
}
