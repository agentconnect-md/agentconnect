#!/usr/bin/env node
/** The in-sandbox shim executable. Lives at a fixed path in the runtime image
 *  (`/opt/agentconnect/shim`), root-owned and read-only, with tini as PID 1. */
import { runSandboxRuntimeProvider } from '../acp/sandbox-runtime-provider.js'
import { ShimClient } from './client.js'
import { createAutoMergeHandler } from './auto-merge-handler.js'
import { createExecHandler } from './exec-handler.js'
import { resolveCommandInPath } from './path-resolve.js'
import {
  DEFAULT_SHIM_LISTEN_PORT,
  DEFAULT_SHIM_WORKSPACE_ROOT,
  SHIM_LISTEN_PORT_ENV,
  SHIM_WORKSPACE_ROOT_ENV
} from './protocol.js'
import { ShimServer } from './server.js'
import { TunnelHost } from './tunnel-host.js'

if (process.argv[2] === '__sandbox-runtime' || process.argv[2] === '__sandbox-runtime-offline') {
  process.exit(
    await runSandboxRuntimeProvider(process.argv.slice(3), {
      offline: process.argv[2] === '__sandbox-runtime-offline'
    })
  )
}

const log = {
  info: (message: string) => console.error(`[shim] ${message}`),
  warn: (message: string) => console.error(`[shim] ${message}`)
}

async function main(): Promise<number> {
  const port = Number(process.env[SHIM_LISTEN_PORT_ENV] ?? DEFAULT_SHIM_LISTEN_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    log.warn(`${SHIM_LISTEN_PORT_ENV} is not a valid port`)
    return 2
  }
  const workspaceRoot = process.env[SHIM_WORKSPACE_ROOT_ENV] ?? DEFAULT_SHIM_WORKSPACE_ROOT
  const exec = createExecHandler({ workspaceRoot, log })
  // Its own handler beside exec: it owns child processes with a pod-long lifetime rather than
  // answering one request, and it must never be reachable through the git-only exec inventory.
  const automerge = createAutoMergeHandler({ log })
  const server = new ShimServer({ log })
  // Tunnel listeners follow pod lifetime so credential renewal cannot break client sockets.
  const tunnels = new TunnelHost({ emit: (streamId, event) => client.emit(streamId, event), log })
  const client = new ShimClient({
    endpoint: 'accepted-daemon-channel',
    dial: () => server.nextTransport(),
    // Without this the runner skips executable hints entirely, so CLAUDE_CODE_EXECUTABLE and
    // path-qualified registry commands would never resolve in the sandbox.
    resolveCommand: resolveCommandInPath,
    // Image-accepted provider config (AC_CLAUDE_*/AC_CODEX_* → the runtime's BASE_URL/API_KEY).
    podEnv: process.env,
    // Serves materialize and git exec, and ENFORCES the declared inventory here rather than
    // trusting that the daemon sent only permitted subcommands; tunnels are served separately
    // because they own long-lived sockets rather than answering one request.
    handle: (capability, payload, abort, context) =>
      capability === 'tunnel'
        ? tunnels.handle(payload)
        : capability === 'automerge'
          ? automerge(payload)
          : exec(capability, payload, abort, context),
    // Reported in the hello so daemon-built pod paths are anchored on this filesystem.
    workspaceRoot,
    features: ['cluster-skills-v1'],
    log
  })
  await server.start(port)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      tunnels.close()
      client.stop()
      void server.stop().finally(() => process.exit(0))
    })
  }
  await client.start()
  // Bound: stay up serving daemon requests until the pod goes away.
  await new Promise<void>(() => {})
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log.warn(`fatal: ${(err as Error).message}`)
    process.exit(1)
  }
)
