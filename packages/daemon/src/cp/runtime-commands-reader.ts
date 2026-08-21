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
  knowsAgent: (agentId: string) => boolean,
  outward: (agentId: string, acpSessionId: string) => Promise<string>
): RuntimeCommandsReader {
  return {
    // An agent this daemon does not run reads as "nothing advertised yet" rather than as another
    // agent's cache entry surviving a move.
    async list(req) {
      if (!knowsAgent(req.agentId)) return { reported: false, commands: [] }
      const entry = commands.get(req.agentId)
      // The cache remembers which runtime session advertised the set; the frame names that session
      // the way everyone outside the ACP hop does (session-concept.md §1.1).
      if (entry.sessionId === undefined) return entry
      return { ...entry, sessionId: await outward(req.agentId, entry.sessionId) }
    }
  }
}
