import { isValidFullRef } from '../workspace/git-command-policy.js'
import { workspaceGitLocalEnv } from '../workspace/git-injection.js'
import type { GitRunner } from '../workspace/git-runner.js'

const SECTIONS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const
const PERMISSION_LISTS = ['allow', 'ask', 'deny'] as const
const DEFAULTS = '$defaults'
const TRACKING_PREFIX = 'refs/remotes/origin/'
const SETTINGS_PATH = './.claude/settings.json'
const MAX_SETTINGS_BYTES = 256 * 1024
// Claude matches paths only in Read and Edit rules, and reads a `/path` one against the folder of the file that holds it.
const PATH_RULE_TOOLS = new Set(['Read', 'Edit'])

/** The prose rule lists of Claude Code's `autoMode` settings block, which its auto mode classifier reads. */
export type ClaudeAutoModeRules = Partial<Record<(typeof SECTIONS)[number], string[]>>

/** The rule lists of Claude Code's `permissions` settings block. */
export type ClaudePermissionRules = Partial<Record<(typeof PERMISSION_LISTS)[number], string[]>>

/** What a repository's settings file passes to its Claude Code sessions. */
export interface ClaudeRepositoryRules {
  autoMode?: ClaudeAutoModeRules
  permissions?: ClaudePermissionRules
}

function settingsObject(settingsJson: string): Record<string, unknown> {
  const settings = JSON.parse(settingsJson) as unknown
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('Claude project settings must be a JSON object')
  }
  return settings as Record<string, unknown>
}

// The named string lists of a settings block, empty entries dropped; a block or list of the wrong shape throws.
function ruleLists<L extends string>(settings: Record<string, unknown>, block: string, lists: readonly L[]) {
  const value = settings[block]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${block} must be a JSON object`)
  }
  const found: Partial<Record<L, string[]>> = {}
  for (const list of lists) {
    const entries = (value as Record<string, unknown>)[list]
    if (entries === undefined) continue
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${block}.${list} must be an array of strings`)
    }
    const own = (entries as string[]).filter((entry) => entry.trim() !== '')
    if (own.length > 0) found[list] = own
  }
  return found
}

function autoModeOf(settings: Record<string, unknown>): ClaudeAutoModeRules | undefined {
  const lists = ruleLists(settings, 'autoMode', SECTIONS)
  const rules: ClaudeAutoModeRules = {}
  for (const section of SECTIONS) {
    const own = lists?.[section]?.filter((entry) => entry !== DEFAULTS) ?? []
    // A repository adds to the built-in rules and never drops them, whatever its file spells.
    if (own.length > 0) rules[section] = [DEFAULTS, ...own]
  }
  return Object.keys(rules).length > 0 ? rules : undefined
}

function permissionsOf(settings: Record<string, unknown>): ClaudePermissionRules | undefined {
  const lists = ruleLists(settings, 'permissions', PERMISSION_LISTS)
  return lists && Object.keys(lists).length > 0 ? lists : undefined
}

/** Keep the rule lists of a settings file's `autoMode`, each extending the built-in rules rather than replacing them. */
export function claudeAutoModeRules(settingsJson: string): ClaudeAutoModeRules | undefined {
  return autoModeOf(settingsObject(settingsJson))
}

/** Keep the `allow`, `ask` and `deny` lists of a settings file's `permissions`, which Claude ignores in a folder nobody has trusted. */
export function claudePermissionRules(settingsJson: string): ClaudePermissionRules | undefined {
  return permissionsOf(settingsObject(settingsJson))
}

/** Everything a settings file passes to its sessions; a file that cannot be used throws and passes nothing. */
export function claudeRepositoryRules(settingsJson: string): ClaudeRepositoryRules | undefined {
  const settings = settingsObject(settingsJson)
  const autoMode = autoModeOf(settings)
  const permissions = permissionsOf(settings)
  if (!autoMode && !permissions) return undefined
  return { ...(autoMode ? { autoMode } : {}), ...(permissions ? { permissions } : {}) }
}

/** `root` as the start of a Claude path rule: `//` marks an absolute path, and glob characters in it are escaped. */
export function claudeAbsolutePathPattern(root: string): string {
  return `/${root.replace(/\/+$/, '').replace(/[\\*?[\] ]/g, (char) => `\\${char}`)}`
}

/** Root a repository's project-relative path rules (`Edit(/src/**)`) at its checkout, since the flag tier's file sits elsewhere. */
export function anchorRepositoryRules(rules: ClaudeRepositoryRules, checkout: string): ClaudeRepositoryRules {
  if (!rules.permissions) return rules
  const root = claudeAbsolutePathPattern(checkout)
  const anchor = (rule: string): string => {
    const match = /^([A-Za-z]+)\((\/(?!\/).*)\)$/.exec(rule)
    return match && PATH_RULE_TOOLS.has(match[1] ?? '') ? `${match[1]}(${root}${match[2]})` : rule
  }
  const permissions: ClaudePermissionRules = {}
  for (const list of PERMISSION_LISTS) {
    const entries = rules.permissions[list]
    if (entries) permissions[list] = entries.map(anchor)
  }
  return { ...rules, permissions }
}

/** The rules a repository grants its sessions: its settings file as the checkout's copy of `branch` holds it, never the working tree's. */
export async function repositoryClaudeRules(
  git: GitRunner,
  branch: string
): Promise<ClaudeRepositoryRules | undefined> {
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
  return claudeRepositoryRules(blob.out.toString('utf8'))
}
