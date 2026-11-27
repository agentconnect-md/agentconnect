// Daemon-owned system skills (skill-over-mcp.md §4.1): versioned with the daemon and served by `readSkill`, never installed on disk.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalSkillSource } from './install-skills.js'

/** The reserved name of the image generate-and-share workflow. */
export const BUILTIN_IMAGES_SKILL = 'agentconnect-images'
export const BUILTIN_PLATFORM_SKILL = 'agentconnect-platform'
export const BUILTIN_CREATE_AGENT_SKILL = 'agentconnect-create-agent'
export const BUILTIN_CREATE_TEAM_SKILL = 'agentconnect-create-team'

/** The system skills `readSkill` serves from memory (skill-over-mcp.md §4.1), in display order. */
export const BUILTIN_MCP_SKILL_NAMES = [
  BUILTIN_IMAGES_SKILL,
  BUILTIN_PLATFORM_SKILL,
  BUILTIN_CREATE_AGENT_SKILL,
  BUILTIN_CREATE_TEAM_SKILL
] as const

export type BuiltinMcpSkillName = (typeof BUILTIN_MCP_SKILL_NAMES)[number]

/** One-line trigger summaries inlined into `readSkill`'s description; keep the four within the 900-char budget. */
export const BUILTIN_MCP_SKILL_SUMMARIES: Readonly<Record<BuiltinMcpSkillName, string>> = Object.freeze({
  'agentconnect-images':
    'Generate, render, edit, or plot an image/chart/diagram, save it to session outputs, and display it inline with shareFile.',
  'agentconnect-platform':
    'Answer questions about AgentConnect concepts/architecture/setup, or administer the organization (agents, daemons, integrations, teams, memory, automations).',
  'agentconnect-create-agent':
    'Create and configure a new AgentConnect agent from role templates (code-reviewer, lead, coder, customer-service, qa) or custom requirements.',
  'agentconnect-create-team':
    'Create and configure a multi-agent team (such as an engineering-pod) and wire its members, repositories, and task board.'
})

export interface BuiltinMcpSkillBundle {
  readonly name: BuiltinMcpSkillName
  /** SKILL.md with its leading YAML frontmatter stripped. */
  readonly body: string
  /** Reference files keyed by POSIX path relative to the skill (`references/…`), sorted. */
  readonly references: ReadonlyMap<string, string>
}

export function isBuiltinMcpSkillName(name: string): name is BuiltinMcpSkillName {
  return (BUILTIN_MCP_SKILL_NAMES as readonly string[]).includes(name)
}

/** Source keys an older daemon gave its installed builtins, so legacy receipts and inventories can tell them apart. */
export const BUILTIN_SKILL_KEY_PREFIX = 'builtin:'

/** The packaged skill directories: beside the bundle in dist, or the package's own builtin-skills in source. */
async function builtinSkillDir(name: string): Promise<string | undefined> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    join(moduleDir, 'builtin-skills', name),
    join(moduleDir, '..', '..', 'builtin-skills', name)
  ]) {
    try {
      return await realpath(candidate)
    } catch {
      // Try the next fixed, daemon-owned layout.
    }
  }
  return undefined
}

/** Drop a leading `---` YAML block; the tool descriptor already carries the name and summary. */
export function stripSkillFrontmatter(raw: string): string {
  const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  return (match ? raw.slice(match[0].length) : raw).replace(/^\s*\n/, '')
}

async function referenceFiles(dir: string, prefix: string, out: Map<string, string>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`
    if (entry.isDirectory()) await referenceFiles(join(dir, entry.name), path, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.set(path, await readFile(join(dir, entry.name), 'utf8'))
  }
}

async function loadBuiltinMcpSkills(): Promise<ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>> {
  const bundles = new Map<BuiltinMcpSkillName, BuiltinMcpSkillBundle>()
  for (const name of BUILTIN_MCP_SKILL_NAMES) {
    const dir = await builtinSkillDir(name)
    if (!dir) continue
    const found = new Map<string, string>()
    await referenceFiles(join(dir, 'references'), 'references', found)
    const references = new Map([...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    bundles.set(name, {
      name,
      body: stripSkillFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8')),
      references
    })
  }
  return bundles
}

let mcpCached: Promise<ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>> | undefined

/** The packaged system skills, read once and then served from memory; a failed read retries on the next call. */
export function builtinMcpSkills(): Promise<ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>> {
  mcpCached ??= loadBuiltinMcpSkills().catch((error: unknown) => {
    mcpCached = undefined
    throw error
  })
  return mcpCached
}

/** Built-in names are reserved: a same-named managed or Dream source is dropped with a diagnosis (skill-over-mcp.md §6.3). */
export function reserveBuiltinSkills(sources: LocalSkillSource[], warn: (message: string) => void): LocalSkillSource[] {
  return sources.filter((source) => {
    // A legacy builtin source is never installed again; readSkill serves it.
    if (source.key.startsWith(BUILTIN_SKILL_KEY_PREFIX)) return false
    if (!isBuiltinMcpSkillName(source.name)) return true
    warn(
      `skills: "${source.name}" is reserved for the daemon's builtin skill; the source ${source.key} is not installed`
    )
    return false
  })
}

/** The preset `agentconnect` Git source (preset-agents.md §3.1), whose skills `readSkill` now serves. */
export const PRESET_AGENTCONNECT_SKILL_NAME = 'agentconnect'
export const PRESET_AGENTCONNECT_SKILL_REPO_ID = '1322557433'
const PRESET_AGENTCONNECT_SKILL_SOURCE_RE =
  /^(?:(?:https?:\/\/(?:www\.)?|ssh:\/\/git@|git@)?github\.com[/:])?agentconnect-md\/agentconnect-skill(?:\.git)?\/?$/i

/** True for the unmodified preset source; a renamed, repointed, re-ref'd, re-rooted or widened one keeps its Git install (skill-over-mcp.md §6.2). */
export function isMigratedBuiltinGitSkillSource(entry: {
  name?: string
  source: string
  githubRepoId?: string
  ref?: string
  subDir?: string
  skills?: readonly string[]
}): boolean {
  if (entry.name !== undefined && entry.name !== PRESET_AGENTCONNECT_SKILL_NAME) return false
  if (!PRESET_AGENTCONNECT_SKILL_SOURCE_RE.test(entry.source.trim())) return false
  if (entry.githubRepoId !== undefined && entry.githubRepoId !== PRESET_AGENTCONNECT_SKILL_REPO_ID) return false
  const ref = entry.ref?.trim()
  if (ref && ref !== 'main') return false
  const subDir = entry.subDir?.trim().replace(/^\/+|\/+$/g, '')
  if (subDir && subDir !== 'skills') return false
  return (entry.skills ?? []).every((skill) => isBuiltinMcpSkillName(skill))
}
