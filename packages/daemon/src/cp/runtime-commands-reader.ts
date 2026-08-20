// CP-facing read of an agent's advertised slash commands (`runtime/commands`). Pure cache read: the
// list is pushed by the runtime, so unlike `skills/local` this never touches a filesystem and
// answers the same way for a local and a cluster agent.

import type { RuntimeCommandsList, RuntimeCommandsReq } from '@agentconnect.md/protocol'
import type { RuntimeCommandsCache } from '../runtimes/runtime-commands.js'

export interface RuntimeCommandsReader {
  list(req: RuntimeCommandsReq): Promise<RuntimeCommandsList>
}

export function createRuntimeCommandsReader(
  commands: RuntimeCommandsCache,
  knowsAgent: (agentId: string) => boolean
): RuntimeCommandsReader {
  return {
    // An agent this daemon does not run reads as "nothing advertised yet" rather than as another
    // agent's cache entry surviving a move.
    async list(req) {
      return knowsAgent(req.agentId) ? commands.get(req.agentId) : { reported: false, commands: [] }
    }
  }
}
