#!/usr/bin/env node
/**
 * The in-sandbox AgentConnect tool server. Lives at a fixed path in the runtime image
 * (`/opt/agentconnect/shim/mcp-bridge.js`), root-owned and read-only like the shim, and is spawned
 * by the agent's own harness from the `mcpServers` spec the daemon sends at `session/new`.
 *
 * Its own entry for the reason the credential helper is one: the harness spawns it per session, the
 * image copies ONE file per bundle, and two entries whose graphs are disjoint stay two single files
 * where a shared module would make rolldown emit a chunk nothing copies.
 *
 * It holds no policy and knows no tools. The endpoint it dials is the `mcp` tunnel's in-pod socket
 * and the token is the daemon's own per-session capability; every tool it serves is resolved on the
 * far side, exactly as for a runtime that shares the daemon's filesystem.
 */
import { runBridge } from '../mcp/bridge.js'

// No version to state: this bundle ships alone, and a package.json placed beside it to read one
// from would change how node interprets every .js in that directory.
runBridge({ lazyTools: process.argv.slice(2).includes('--lazy-tools') }).catch((err: unknown) => {
  process.stderr.write(`agentconnect: mcp-bridge failed: ${(err as Error).message}\n`)
  process.exit(1)
})
