/**
 * Seeds the DeepSeek Harness preset a sandbox runs on, so `web_search` is not offered in a pod.
 *
 * The tool cannot work there: the harness's search provider deliberately ignores
 * `$DEEPSEEK_BASE_URL` and takes `$DEEPSEEK_API_KEY` to api.deepseek.com itself, so a pod whose key
 * is a gateway credential answers every search with an invalid-key error the model then retries.
 *
 * Why a whole preset and not a config knob: `web_search` is a row in the AGENT PRESET, and a preset
 * composition is only ever edited as a file — the host-plane patch layer cannot reach into a preset
 * subtree, and disabling the host `web` service instead makes the preset refuse to mount, because a
 * row waiting on a service the composition never supplies fails the roster's own audit. So the image
 * bakes a copy of the shipped `standard` with the tool deregistered, and this puts that copy where
 * the roster looks: `$DSH_HOME/.agent-presets`, the user root it appends after every configured one.
 *
 * The seed runs per spawn rather than once per pod: `$DSH_HOME` lives on the agent's workspace
 * volume, which outlives the image it was first written by, so re-copying is what carries an image
 * upgrade to an agent that already has a volume.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SANDBOX_DSH_PRESET_DIR, SANDBOX_DSH_PRESET_ID } from './sandbox-paths.js'

/** Pod env a deployment sets to keep the shipped preset — its DeepSeek key reaches the real API, so
 *  its agents can search. Template-owned like the provider pairs beside it: only the deployment knows
 *  whose credential the pod carries. */
export const DSH_WEB_SEARCH_POD_ENV = 'AC_DEEPSEEK_WEB_SEARCH'

/** Where the roster reads a person's own presets, under `$DSH_HOME`. */
const USER_PRESET_ROOT = '.agent-presets'

/** The harness's user settings document, whose `agent-presets.default` layers over the composition. */
const SETTINGS_FILE = 'settings.yaml'

const AFFIRMATIVE = new Set(['on', 'true', '1', 'yes'])
const NEGATIVE = new Set(['', 'off', 'false', '0', 'no'])

/** Whether the deployment asked for the shipped preset. An affirmative token is required: this
 *  switch hands a tool back, so an unrecognized value must not read as "on" by accident. */
export function podKeepsWebSearch(
  podEnv: Record<string, string | undefined>,
  warn?: (message: string) => void
): boolean {
  const raw = (podEnv[DSH_WEB_SEARCH_POD_ENV] ?? '').trim().toLowerCase()
  if (AFFIRMATIVE.has(raw)) return true
  if (!NEGATIVE.has(raw)) {
    warn?.(`acp: ${DSH_WEB_SEARCH_POD_ENV}="${raw}" is not a yes/no value — leaving DeepSeek web search off`)
  }
  return false
}

/** The harness home the runtime will use, from the env it is about to be spawned with. */
export function dshHomeOf(env: Record<string, string | undefined>): string | undefined {
  const explicit = env.DSH_HOME?.trim()
  if (explicit) return explicit
  const home = env.HOME?.trim()
  return home ? join(home, '.dsh') : undefined
}

/**
 * The settings document that names `presetId` as the default, or `undefined` to leave the file as it
 * is. An existing `agent-presets` block is never rewritten: it is either a deployment's choice or a
 * session's own preset switch, and both outrank this floor.
 */
export function settingsWithPresetDefault(existing: string | undefined, presetId: string): string | undefined {
  const block = `agent-presets:\n  default: ${presetId}\n`
  if (existing === undefined) return block
  if (/^agent-presets:/m.test(existing)) return undefined
  return `${existing.endsWith('\n') || existing === '' ? existing : `${existing}\n`}${block}`
}

/**
 * Copy the baked preset into the pod's `$DSH_HOME` and point the default at it.
 *
 * Every step degrades to "launch as before" rather than failing the spawn: an older image ships no
 * preset, and a harness that keeps its web tool is a worse agent, not a broken one.
 */
export function seedDshPreset(opts: {
  /** The env the runtime is about to be spawned with — the one that decides `$DSH_HOME`. */
  env: Record<string, string>
  podEnv: Record<string, string | undefined>
  /** Test seam: the image directory the preset is copied from. */
  source?: string
  log?: { info?: (message: string) => void; warn?: (message: string) => void }
}): void {
  const source = opts.source ?? SANDBOX_DSH_PRESET_DIR
  if (podKeepsWebSearch(opts.podEnv, opts.log?.warn)) return
  if (!existsSync(source)) return
  const home = dshHomeOf(opts.env)
  if (!home) {
    opts.log?.warn?.('acp: no HOME for the DeepSeek Harness, so its web search stays as the preset ships it')
    return
  }
  try {
    const target = join(home, USER_PRESET_ROOT, SANDBOX_DSH_PRESET_ID)
    mkdirSync(dirname(target), { recursive: true })
    // Replaced rather than merged: a directory left by an earlier image must not keep a file the
    // current preset no longer has, and the image's copy is read-only, which an overwrite trips on.
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true, dereference: true })
    const settings = join(home, SETTINGS_FILE)
    const next = settingsWithPresetDefault(
      existsSync(settings) ? readFileSync(settings, 'utf8') : undefined,
      SANDBOX_DSH_PRESET_ID
    )
    if (next !== undefined) writeFileSync(settings, next)
    opts.log?.info?.(`acp: DeepSeek Harness sessions default to ${SANDBOX_DSH_PRESET_ID} (no web_search)`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    opts.log?.warn?.(`acp: leaving the DeepSeek Harness preset unseeded — ${reason}`)
  }
}
