import { isValidFullRef } from '../workspace/git-command-policy.js'
import { workspaceGitLocalEnv } from '../workspace/git-injection.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SECTIONS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const
const DEFAULTS = '$defaults'
const TRACKING_PREFIX = 'refs/remotes/origin/'
const SETTINGS_PATH = './.claude/settings.json'
const MAX_SETTINGS_BYTES = 256 * 1024

/** The prose rule lists of Claude Code's `autoMode` settings block, which its auto mode classifier reads. */
export type ClaudeAutoModeRules = Partial<Record<(typeof SECTIONS)[number], string[]>>

/** Keep the rule lists of a settings file's `autoMode`, each extending the built-in rules rather than replacing them. */
export function claudeAutoModeRules(settingsJson: string): ClaudeAutoModeRules | undefined {
  const settings = JSON.parse(settingsJson) as unknown
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('Claude project settings must be a JSON object')
  }
  const autoMode = (settings as Record<string, unknown>).autoMode
  if (autoMode === undefined) return undefined
  if (typeof autoMode !== 'object' || autoMode === null || Array.isArray(autoMode)) {
    throw new Error('autoMode must be a JSON object')
  }
  const rules: ClaudeAutoModeRules = {}
  for (const section of SECTIONS) {
    const entries = (autoMode as Record<string, unknown>)[section]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw new Error(`autoMode.${section} must be an array of strings`)
    }
    const own = (entries as string[]).filter((entry) => entry.trim() !== '' && entry !== DEFAULTS)
    // A repository adds to the built-in rules and never drops them, whatever its file spells.
    if (own.length > 0) rules[section] = [DEFAULTS, ...own]
  }
  return Object.keys(rules).length > 0 ? rules : undefined
}

/** The rules a repository grants its sessions: its settings file as the checkout's copy of `branch` holds it, never the working tree's. */
export async function repositoryAutoModeRules(
  git: GitRunner,
  branch: string
): Promise<ClaudeAutoModeRules | undefined> {
  const ref = `${TRACKING_PREFIX}${branch}`
  if (!isValidFullRef(ref, TRACKING_PREFIX)) return undefined
  const read = git.withEnv({ ...workspaceGitLocalEnv(), GIT_OPTIONAL_LOCKS: '0' })
  // No checkout, no such branch, or no settings file there: the repository grants nothing.
  const oid = (
    await read.readBounded(['rev-parse', '--verify', '--quiet', `${ref}:${SETTINGS_PATH}`], 256).catch(() => undefined)
  )?.out
    .toString()
    .trim()
  if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) return undefined
  const blob = await read.readBounded(['cat-file', 'blob', oid], MAX_SETTINGS_BYTES)
  if (blob.overflow) throw new Error(`Claude project settings on ${branch} exceed ${MAX_SETTINGS_BYTES} bytes`)
  return claudeAutoModeRules(blob.out.toString('utf8'))
}
