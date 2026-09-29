// Select the image's no-search DeepSeek bundle; older images still seed their file-based preset.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SANDBOX_DSH_PRESET_DIR, SANDBOX_DSH_PRESET_ID } from './sandbox-paths.js'

// Deployment-owned opt-in to the shipped preset's web search.
export const DSH_WEB_SEARCH_POD_ENV = 'AC_DEEPSEEK_WEB_SEARCH'

/** Where the roster reads a person's own presets, under `$DSH_HOME`. */
const USER_PRESET_ROOT = '.agent-presets'

/** The harness's user settings document, whose `agent-presets.default` layers over the composition. */
const SETTINGS_FILE = 'settings.yaml'

const AFFIRMATIVE = new Set(['on', 'true', '1', 'yes'])
const NEGATIVE = new Set(['', 'off', 'false', '0', 'no'])

// Only an affirmative token enables web search.
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

// Keep an existing agent-presets block because it outranks the image default.
export function settingsWithPresetDefault(existing: string | undefined, presetId: string): string | undefined {
  const block = `agent-presets:\n  default: ${presetId}\n`
  if (existing === undefined) return block
  if (/^agent-presets:/m.test(existing)) return undefined
  return `${existing.endsWith('\n') || existing === '' ? existing : `${existing}\n`}${block}`
}

/** Return the baked bundle path, or seed the file-based preset shipped by an older image. */
export function seedDshPreset(opts: {
  /** The runtime's launch env, used by older file-based presets. */
  env: Record<string, string>
  podEnv: Record<string, string | undefined>
  /** Test seam: the image preset or bundle directory. */
  source?: string
  log?: { info?: (message: string) => void; warn?: (message: string) => void }
}): string | undefined {
  const source = opts.source ?? SANDBOX_DSH_PRESET_DIR
  if (podKeepsWebSearch(opts.podEnv, opts.log?.warn)) return
  if (!existsSync(source)) return
  if (existsSync(join(source, 'package.json'))) {
    if (!existsSync(join(source, 'cordis.patch.yml'))) {
      opts.log?.warn?.('acp: the DeepSeek no-search bundle has no patch')
      return
    }
    opts.log?.info?.(`acp: DeepSeek Harness sessions use ${SANDBOX_DSH_PRESET_ID} (no web_search)`)
    return source
  }
  const home = dshHomeOf(opts.env)
  if (!home) {
    opts.log?.warn?.('acp: no HOME for the DeepSeek Harness, so its web search stays as the preset ships it')
    return
  }
  try {
    const target = join(home, USER_PRESET_ROOT, SANDBOX_DSH_PRESET_ID)
    mkdirSync(dirname(target), { recursive: true })
    // Replace the old image's preset, including files this image no longer ships.
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
