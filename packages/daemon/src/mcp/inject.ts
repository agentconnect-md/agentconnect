import { RESERVED_MCP_SERVER_NAME } from '@agentconnect.md/protocol'
import { existsSync, realpathSync } from 'node:fs'
import { canonicalNodeExecArgv } from '../runtimes/node-exec-argv.js'
import { SANDBOX_TUNNEL_PATHS } from '../shim/sandbox-paths.js'

/** The stdio MCP-server spec we hand to ACP's `session/new` (`McpServerStdio`). */
export interface McpStdioServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

/**
 * Build the `mcpServers` entry that makes the agent harness spawn our stdio
 * bridge. `cliEntry` is the daemon entry resolved via `<root>/current` (§8) so
 * the spawned bridge survives daemon upgrades; combined with the current
 * interpreter it works under both `tsx` in dev and plain `node` in prod. We
 * invoke the hidden `mcp-bridge` subcommand. The socket path and per-session
 * token travel via env — they reach only the harness-spawned subprocess, never
 * the model.
 */
export function buildMcpServers(opts: {
  socketPath: string
  token: string
  cliEntry: string
  name?: string
  /** Private delegated brokers fetch tools dynamically so a CP outage does not kill the bridge. */
  lazyTools?: boolean
}): McpStdioServer[] {
  const cliEntry = existsSync(opts.cliEntry) ? realpathSync(opts.cliEntry) : opts.cliEntry
  return [
    {
      name: opts.name ?? RESERVED_MCP_SERVER_NAME,
      command: realpathSync(process.execPath),
      args: [...canonicalNodeExecArgv(), cliEntry, 'mcp-bridge', ...(opts.lazyTools ? ['--lazy-tools'] : [])],
      env: [
        { name: 'AC_MCP_ENDPOINT', value: opts.socketPath },
        { name: 'AC_MCP_TOKEN', value: opts.token }
      ]
    }
  ]
}

/** Use the image's bridge command with the local guest socket; pool paths remain the default. */
export function buildSandboxMcpServers(opts: {
  bridge: { command: string; args: string[] }
  token: string
  socketPath?: string
}): McpStdioServer[] {
  return [
    {
      name: RESERVED_MCP_SERVER_NAME,
      command: opts.bridge.command,
      args: [...opts.bridge.args],
      env: [
        { name: 'AC_MCP_ENDPOINT', value: opts.socketPath ?? SANDBOX_TUNNEL_PATHS.mcp },
        { name: 'AC_MCP_TOKEN', value: opts.token }
      ]
    }
  ]
}
