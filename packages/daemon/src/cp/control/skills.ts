import type { AnyFrame, LocalSkillsReq, RuntimeCommandsReq } from '@agentconnect.md/protocol'
import type { LocalSkillsReader } from '../local-skills-reader.js'
import type { RuntimeCommandsReader } from '../runtime-commands-reader.js'
import type { ControlHandler } from './context.js'

export interface SkillsControlDeps {
  /** Read-only inventory of the skills an agent's workspace can load (skills/local). */
  localSkillsReader: LocalSkillsReader
  /** The slash commands the agent's runtime advertised over ACP (runtime/commands). */
  runtimeCommandsReader: RuntimeCommandsReader
}

export const skillsLocal: ControlHandler<SkillsControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.localSkillsReader
    .list(frame.payload as LocalSkillsReq)
    .then((list) => wire.reply(frame, 'skills/local/list', list))
    .catch((err) => {
      wire.log.warn(`cp: skills/local failed: ${(err as Error)?.message}`)
      wire.sendError(frame.id, 'INTERNAL', 'skills/local failed', false)
    })
}

export const runtimeCommands: ControlHandler<SkillsControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.runtimeCommandsReader
    .list(frame.payload as RuntimeCommandsReq)
    .then((list) => wire.reply(frame, 'runtime/commands/list', list))
    .catch((err) => {
      wire.log.warn(`cp: runtime/commands failed: ${(err as Error)?.message}`)
      wire.sendError(frame.id, 'INTERNAL', 'runtime/commands failed', false)
    })
}
