// CP-facing read of an agent's workspace skill inventory (skills/local). Bodies
// stay daemon-local; only per-skill metadata is returned. An agent whose
// workspace has not been materialized reports materialized=false with no skills,
// so the console can tell "not prepared yet" from "prepared, but no skills".

import { existsSync } from 'node:fs'
import type { LocalSkillsList, LocalSkillsReq } from '@agentconnect.md/protocol'
import { listLocalSkills } from '../skills/local-skill-inventory.js'

export interface LocalSkillsReader {
  list(req: LocalSkillsReq): Promise<LocalSkillsList>
}

export function createLocalSkillsReader(
  workspacePathFor: (agentId: string) => string | undefined,
  stateDir: string
): LocalSkillsReader {
  return {
    async list(req) {
      const cwd = workspacePathFor(req.agentId)
      if (!cwd || !existsSync(cwd)) return { materialized: false, skills: [] }
      return { materialized: true, skills: await listLocalSkills(cwd, stateDir) }
    }
  }
}
