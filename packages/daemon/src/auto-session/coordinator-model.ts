// The model, run settings and permission mode a coordinator runs with (auto-session-mode.md §5.4).
import {
  ASSISTANT_MODE_PERMISSION_MODES,
  COORDINATOR_DEFAULT_EFFORT,
  defaultCoordinatorModel,
  type CoordinatorModel,
  type DecisionRuntimeTarget,
  type RuntimeModelCatalog
} from '@agentconnect.md/protocol'
import { readOnlyExtractionMode } from '../memory/distill.js'

export interface CoordinatorAgent {
  runtime: string
  runtimeOverrides?: { model?: string }
  coordinatorModel?: CoordinatorModel
}

/** The agent's coordinator model, or Default: the newest small model of the agent's runtime at low effort, else its task model. */
export function coordinatorTarget(
  agent: CoordinatorAgent,
  catalog: (runtime: string) => RuntimeModelCatalog | undefined
): DecisionRuntimeTarget {
  const chosen = agent.coordinatorModel
  if (chosen)
    return { runtime: chosen.runtime, model: chosen.model, effort: chosen.effort ?? '', fastMode: !!chosen.fastMode }
  const models = catalog(agent.runtime)?.models ?? []
  const model = defaultCoordinatorModel(agent.runtime, models) ?? agent.runtimeOverrides?.model ?? ''
  const efforts = models.find((candidate) => candidate.id === model)?.efforts
  // A catalog that lists efforts without low leaves the model's own default.
  const effort =
    !efforts || efforts.some((e) => e.value === COORDINATOR_DEFAULT_EFFORT) ? COORDINATOR_DEFAULT_EFFORT : ''
  return { runtime: agent.runtime, model, effort, fastMode: false }
}

// Claude Code's plan mode runs Haiku as Sonnet, so a Claude coordinator asks for every write in `default`, and the daemon refuses each ask.
const ASKS_EVERY_WRITE: Readonly<Record<string, string>> = Object.freeze({ 'claude-acp': 'default', claude: 'default' })

/** The mode whose every write is asked and refused, else the runtime's read-only mode, else its auto mode; undefined leaves the runtime's own. */
export function coordinatorPermissionMode(runtime: string, offered: readonly string[]): string | undefined {
  const asking = Object.prototype.hasOwnProperty.call(ASKS_EVERY_WRITE, runtime) ? ASKS_EVERY_WRITE[runtime] : undefined
  if (asking && offered.includes(asking)) return asking
  const readOnly = readOnlyExtractionMode([...offered])
  if (readOnly) return readOnly
  const kinds = Object.prototype.hasOwnProperty.call(ASSISTANT_MODE_PERMISSION_MODES, runtime)
    ? ASSISTANT_MODE_PERMISSION_MODES[runtime]!
    : {}
  return offered.find((mode) => kinds[mode] === 'auto')
}
