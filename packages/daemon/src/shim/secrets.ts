#!/usr/bin/env node
// The in-sandbox `agentconnect-secrets` (capability-requests.md §4.9.2): `/opt/agentconnect/pathbin/agentconnect-secrets` runs this.
// Its own entry for the reason gh-token is one: the image copies one file per bundle.
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { runSecretsHelper } from '../gitcred/secrets-client.js'
import { SANDBOX_TUNNEL_PATHS } from './sandbox-paths.js'

runSecretsHelper(process.argv.slice(2), {
  // The tunnel's path unless something names another; a pod has no daemon root to derive one from.
  socketPath: process.env[GITCRED_SOCKET_ENV]?.trim() || SANDBOX_TUNNEL_PATHS.gitcred,
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
}).then(
  // An exit code, not process.exit: `eval "$(agentconnect-secrets env …)"` reads a pipe that must drain first.
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`agentconnect-secrets: failed: ${(err as Error).message}\n`)
    process.exitCode = 1
  }
)
