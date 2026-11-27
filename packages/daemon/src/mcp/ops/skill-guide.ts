// `readSkill`: the daemon's built-in system skills served from memory over the MCP bridge (skill-over-mcp.md §4).
import { z } from 'zod'
import type { Logger } from '../../log.js'
import {
  BUILTIN_CREATE_AGENT_SKILL,
  BUILTIN_CREATE_TEAM_SKILL,
  BUILTIN_IMAGES_SKILL,
  BUILTIN_MCP_SKILL_NAMES,
  BUILTIN_MCP_SKILL_SUMMARIES,
  BUILTIN_PLATFORM_SKILL,
  builtinMcpSkills,
  isBuiltinMcpSkillName,
  type BuiltinMcpSkillBundle,
  type BuiltinMcpSkillName
} from '../../skills/builtin-skills.js'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import { optionalString, parseArgs, ToolArgumentError } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'

export const READ_SKILL_TOOL_NAME = 'readSkill'

/** Above this the per-skill summaries move out of the description, well under the Codex 1,024-char ceiling. */
export const INLINE_SUMMARY_CHAR_BUDGET = 900

const DESCRIPTION_HEAD =
  'Read an AgentConnect system skill (SKILL.md instructions) or one of its bundled reference files on demand.'

/** The heading standing instructions carry when the summaries no longer fit the description. */
export const AVAILABLE_SYSTEM_SKILLS_HEADING = '# Available system skills (load with readSkill)'

function summaryLines(skills: readonly BuiltinMcpSkillName[]): string {
  return skills.map((name) => `- ${name}: ${BUILTIN_MCP_SKILL_SUMMARIES[name]}`).join('\n')
}

/** Whether `skills` overflow the inline description, so standing instructions must list them instead. */
export function readSkillSummariesInline(skills: readonly BuiltinMcpSkillName[]): boolean {
  return (
    `${DESCRIPTION_HEAD} Call this tool BEFORE handling a request that matches an available skill:\n${summaryLines(skills)}`
      .length <= INLINE_SUMMARY_CHAR_BUDGET
  )
}

/** The standing-instructions index, only when the description cannot carry the summaries. */
export function systemSkillsInstructions(skills: readonly BuiltinMcpSkillName[]): string | undefined {
  if (skills.length === 0 || readSkillSummariesInline(skills)) return undefined
  return `${AVAILABLE_SYSTEM_SKILLS_HEADING}\n${summaryLines(skills)}`
}

/** The session's `readSkill` descriptor; its description and `name` enum list exactly the skills it may read. */
export function buildReadSkillTool(
  availableSkills: readonly BuiltinMcpSkillName[] = BUILTIN_MCP_SKILL_NAMES
): ToolDescriptor {
  const description = readSkillSummariesInline(availableSkills)
    ? `${DESCRIPTION_HEAD} Call this tool BEFORE handling a request that matches an available skill:\n${summaryLines(availableSkills)}`
    : `${DESCRIPTION_HEAD} Call this tool with a skill name listed under "${AVAILABLE_SYSTEM_SKILLS_HEADING.slice(2)}" in your standing instructions.`
  return {
    name: READ_SKILL_TOOL_NAME,
    description,
    inputSchema: obj(
      {
        name: { type: 'string', enum: [...availableSkills], description: 'System skill name to read.' },
        path: {
          type: 'string',
          description:
            'Optional relative path to a bundled reference file inside the skill (for example ' +
            '"references/admin-operations.md"). Omit on the first call to read SKILL.md and list its reference files.'
        }
      },
      ['name']
    )
  }
}

export const READ_SKILL_ARGS = z.strictObject({
  name: z.enum(
    BUILTIN_MCP_SKILL_NAMES,
    `argument name must be one of the built-in system skills: ${BUILTIN_MCP_SKILL_NAMES.join(', ')}. readSkill ` +
      'loads only these; organization skills from listOrgSkills are installed in the workspace when enabled on the agent'
  ),
  path: optionalString('path')
})

/** The built-in skills a session offers (§4.2.3): none to restricted internal subsessions. */
export function resolveSessionBuiltinSkills(input: {
  tools: readonly ToolDescriptor[]
  hasAdminMcp: boolean
  restricted: boolean
}): BuiltinMcpSkillName[] {
  if (input.restricted) return []
  const skills: BuiltinMcpSkillName[] = []
  if (input.tools.some((tool) => tool.name === 'shareFile')) skills.push(BUILTIN_IMAGES_SKILL)
  skills.push(BUILTIN_PLATFORM_SKILL)
  if (input.hasAdminMcp) skills.push(BUILTIN_CREATE_AGENT_SKILL, BUILTIN_CREATE_TEAM_SKILL)
  return skills
}

/** The skills this session may read: its recorded set, else the advertised descriptor's enum. */
export function allowedSessionSkills(ctx: Pick<SessionContext, 'builtinSkills' | 'tools'>): BuiltinMcpSkillName[] {
  if (ctx.builtinSkills) return [...ctx.builtinSkills]
  const advertised = ctx.tools.find((tool) => tool.name === READ_SKILL_TOOL_NAME)
  const values = (advertised?.inputSchema.properties as Record<string, { enum?: unknown }> | undefined)?.name?.enum
  return Array.isArray(values)
    ? values.filter((value): value is BuiltinMcpSkillName => isBuiltinMcpSkillName(value))
    : []
}

/** Swap a session's `readSkill` descriptor in place, so a registered context and its snapshot stay one list. */
export function replaceReadSkillTool(tools: ToolDescriptor[], skills: readonly BuiltinMcpSkillName[]): void {
  const at = tools.findIndex((tool) => tool.name === READ_SKILL_TOOL_NAME)
  if (at === -1) return
  if (skills.length === 0) tools.splice(at, 1)
  else tools[at] = buildReadSkillTool(skills)
}

export interface ResolvedSkillPath {
  skill: BuiltinMcpSkillName
  /** `undefined` reads SKILL.md. */
  path?: string
}

/** Tolerant path normalization (§4.4): content is only ever looked up in the in-memory map, never on disk. */
export function normalizeSkillReferencePath(
  skill: BuiltinMcpSkillName,
  raw: string | undefined,
  allowed: readonly BuiltinMcpSkillName[],
  bundles: ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>
): ResolvedSkillPath {
  let path = (raw ?? '').trim().replace(/\\/g, '/')
  // Relative links between skills (`../../../agentconnect-create-agent/references/…`) climb before they name the skill.
  while (/^(?:\.{1,2}\/|\/)/.test(path)) path = path.replace(/^(?:\.{1,2}\/|\/)/, '')
  if (path === '' || path.toLowerCase() === 'skill.md') return { skill }
  const slash = path.indexOf('/')
  const head = slash === -1 ? '' : path.slice(0, slash)
  if (isBuiltinMcpSkillName(head) && allowed.includes(head)) {
    skill = head
    path = path.slice(slash + 1)
    if (path === '' || path.toLowerCase() === 'skill.md') return { skill }
  }
  const references = bundles.get(skill)?.references
  if (references && !references.has(path) && references.has(`references/${path}`)) path = `references/${path}`
  return { skill, path }
}

function banner(skill: string, path?: string): string {
  if (path) return `> [MCP System Skill: ${skill} — ${path}] Served via AgentConnect MCP (\`readSkill\`).`
  return (
    `> [MCP System Skill: ${skill}] This skill is served in memory via the AgentConnect MCP server (it is NOT on ` +
    'the workspace filesystem). To read any reference file cited below, call the `readSkill` tool with ' +
    `\`{"name": "${skill}", "path": "references/..."}\` — do not use filesystem Read/cat tools. If any tool ` +
    'argument example below differs from the live MCP tool schema in your session, follow the live tool schema.'
  )
}

export interface ReadSkillDeps {
  log?: Pick<Logger, 'debug'>
  /** Tests inject the bundle map; production reads the packaged skills once. */
  builtinSkills?: () => Promise<ReadonlyMap<BuiltinMcpSkillName, BuiltinMcpSkillBundle>>
}

export const readSkill: ToolHandler<ReadSkillDeps> = async (ctx, args, deps) => {
  const { name, path: rawPath } = parseArgs(READ_SKILL_ARGS, args)
  const allowed = allowedSessionSkills(ctx)
  if (!allowed.includes(name)) {
    throw new ToolArgumentError([
      allowed.length > 0
        ? `skill "${name}" is not available in this session; available skills: ${allowed.join(', ')}`
        : `skill "${name}" is not available in this session; no system skills are offered here`
    ])
  }
  const bundles = await (deps.builtinSkills ?? builtinMcpSkills)()
  const { skill, path } = normalizeSkillReferencePath(name, rawPath, allowed, bundles)
  const bundle = bundles.get(skill)
  if (!bundle) throw new Error(`readSkill: skill "${skill}" is not packaged with this daemon`)
  const listed = [...bundle.references.keys()]
  if (path === undefined) {
    deps.log?.debug(`mcp: readSkill agent=${ctx.agentId} platform=${ctx.platform} skill=${skill} path=SKILL.md`)
    const manifest =
      listed.length > 0
        ? '\n\n---\n## Bundled reference files in `' +
          skill +
          '`\nLoad any reference file needed for the current step by calling `readSkill` with ' +
          `\`{"name": "${skill}", "path": "<path>"}\`:\n${listed.map((entry) => `- \`${entry}\``).join('\n')}`
        : ''
    return {
      skill,
      path: 'SKILL.md',
      ...(listed.length > 0 ? { references: listed } : {}),
      content: `${banner(skill)}\n\n${bundle.body.trimEnd()}${manifest}`
    }
  }
  const content = bundle.references.get(path)
  if (content === undefined) {
    throw new ToolArgumentError([
      listed.length > 0
        ? `readSkill: unknown reference path "${rawPath}" for skill "${skill}". Available reference paths: ` +
          `${listed.map((entry) => `"${entry}"`).join(', ')} (or omit \`path\` to read SKILL.md).`
        : `readSkill: skill "${skill}" has no bundled reference files; omit \`path\` to read SKILL.md.`
    ])
  }
  deps.log?.debug(`mcp: readSkill agent=${ctx.agentId} platform=${ctx.platform} skill=${skill} path=${path}`)
  return { skill, path, content: `${banner(skill, path)}\n\n${content.trimEnd()}` }
}
