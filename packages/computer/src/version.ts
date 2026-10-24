import { readFileSync } from 'node:fs'

// Set by scripts/bundle.mjs from package.json; a source run (tsx, tests) reads the manifest instead.
declare const __AGENTCONNECT_COMPUTER_VERSION__: string | undefined

// The desktop daemon's version, reported to MCP clients, on the Computer channel and by doctor.
export const COMPUTER_DAEMON_VERSION: string =
  typeof __AGENTCONNECT_COMPUTER_VERSION__ === 'string'
    ? __AGENTCONNECT_COMPUTER_VERSION__
    : (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
