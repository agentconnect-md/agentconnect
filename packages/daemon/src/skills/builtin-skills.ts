// Daemon-owned builtin skills (webchat-generated-images.md §3): versioned with the daemon, installed through the ordinary ledger.
import { createHash } from 'node:crypto'
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

/** Source keys of builtin skills start here, so receipts and inventories can tell them apart. */
export const BUILTIN_SKILL_KEY_PREFIX = 'builtin:'

let cached: Promise<LocalSkillSource[]> | undefined

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

async function loadBuiltinSkillSources(): Promise<LocalSkillSource[]> {
  const sources: LocalSkillSource[] = []
  for (const name of [BUILTIN_IMAGES_SKILL]) {
    const sourceDir = await builtinSkillDir(name)
    if (!sourceDir) continue
    const digest = createHash('sha256')
      .update(await readFile(join(sourceDir, 'SKILL.md')))
      .digest('hex')
    sources.push({
      kind: 'managed',
      key: `${BUILTIN_SKILL_KEY_PREFIX}${name}:${digest}`,
      name,
      sourceDir,
      contentDigest: digest
    })
  }
  return sources
}

/** The builtin skill sources this daemon ships; empty when the package lacks them, never a startup failure. */
export function builtinSkillSources(): Promise<LocalSkillSource[]> {
  cached ??= loadBuiltinSkillSources().catch(() => [])
  return cached
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

/** Builtins win their reserved names and install last; a same-named configured source is dropped with a diagnosis. */
export function reserveBuiltinSkills(sources: LocalSkillSource[], warn: (message: string) => void): LocalSkillSource[] {
  const builtins = sources.filter((source) => source.key.startsWith(BUILTIN_SKILL_KEY_PREFIX))
  const reserved = new Set(builtins.map((source) => source.name))
  const kept = sources.filter((source) => {
    if (source.key.startsWith(BUILTIN_SKILL_KEY_PREFIX)) return false
    if (!reserved.has(source.name)) return true
    warn(
      `skills: "${source.name}" is reserved for the daemon's builtin skill; the source ${source.key} is not installed`
    )
    return false
  })
  return [...kept, ...builtins]
}
