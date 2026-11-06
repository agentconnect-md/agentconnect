// The model an `auto` coordinator runs on (auto-session-mode.md §5.4); a leaf module, so the console may import it.
import { z } from 'zod'

const Text = z.string().trim().min(1)

/** An agent's coordinator model: its own runtime, model and run settings, apart from the task model. */
export const CoordinatorModel = z.strictObject({
  runtime: Text.max(128),
  model: Text.max(256),
  effort: z.string().trim().max(128).optional(),
  fastMode: z.boolean().optional()
})
export type CoordinatorModel = z.infer<typeof CoordinatorModel>

/** The effort a coordinator runs at unless one is chosen: it reads messages and starts tasks, so it needs little. */
export const COORDINATOR_DEFAULT_EFFORT = 'low'

export interface CoordinatorModelOption {
  id: string
  name?: string | null
}

const versionOf = (id: string): number[] =>
  (id.match(/\d+(?:\.\d+)*/g) ?? []).flatMap((part) => part.split('.').map(Number))

const newestFirst = (a: CoordinatorModelOption, b: CoordinatorModelOption): number => {
  const [x, y] = [versionOf(a.id), versionOf(b.id)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1)
    if (d) return d
  }
  return 0
}

// Each runtime's small, fast tier by model id; Codex starts at terra, since its mini models are too weak to coordinate.
const DEFAULT_TIER: Readonly<Record<string, RegExp>> = Object.freeze({
  'claude-acp': /haiku/i,
  claude: /haiku/i,
  'codex-acp': /-terra\b/i,
  codex: /-terra\b/i
})

/** The model "Default" means for `runtime` among the models it offers: its newest small tier, else undefined, which follows the task model. */
export function defaultCoordinatorModel(
  runtime: string,
  models: readonly CoordinatorModelOption[]
): string | undefined {
  const tier = Object.prototype.hasOwnProperty.call(DEFAULT_TIER, runtime) ? DEFAULT_TIER[runtime] : undefined
  if (!tier) return undefined
  const matching = models.filter((model) => tier.test(model.id))
  // A bare alias (Claude Code's `haiku`) is the runtime's own newest of the tier.
  return (matching.find((model) => !/\d/.test(model.id)) ?? [...matching].sort(newestFirst)[0])?.id
}
