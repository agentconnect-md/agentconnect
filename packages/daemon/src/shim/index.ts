#!/usr/bin/env node
/** The in-sandbox shim executable. Lives at a fixed path in the runtime image
 *  (`/opt/agentconnect/shim`), root-owned and read-only, with tini as PID 1. */
import { ClientTransport } from '@agentconnect.md/connection'
import { ShimClient, type ShimTransport } from './client.js'
import { createExecHandler } from './exec-handler.js'
import { resolveCommandInPath } from './path-resolve.js'
import { SHIM_ENDPOINT_ENV, SHIM_WORKSPACE_ROOT_ENV } from './protocol.js'

const log = {
  info: (message: string) => console.error(`[shim] ${message}`),
  warn: (message: string) => console.error(`[shim] ${message}`)
}

async function main(): Promise<number> {
  const endpoint = process.env[SHIM_ENDPOINT_ENV]?.trim()
  if (!endpoint) {
    log.warn(`${SHIM_ENDPOINT_ENV} is not set — nothing to dial`)
    return 2
  }
  const client = new ShimClient({
    endpoint,
    dial: (url, opts) =>
      ClientTransport.dial(url, { subprotocol: opts.subprotocol, path: opts.path }) as Promise<ShimTransport>,
    // Without this the runner skips executable hints entirely, so CLAUDE_CODE_EXECUTABLE and
    // path-qualified registry commands would never resolve in the sandbox.
    resolveCommand: resolveCommandInPath,
    // Image-accepted provider config (AC_CLAUDE_*/AC_CODEX_* → the runtime's BASE_URL/API_KEY).
    podEnv: process.env,
    // Serves materialize and git exec, and ENFORCES the declared inventory here rather than
    // trusting that the daemon sent only permitted subcommands.
    handle: createExecHandler({ workspaceRoot: process.env[SHIM_WORKSPACE_ROOT_ENV] ?? '/agent', log }),
    log
  })
  // A signal is the pod being torn down; drop the channel rather than racing the
  // container's exit, since every credential we hold is re-obtained on the next bind.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      client.stop()
      process.exit(0)
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
