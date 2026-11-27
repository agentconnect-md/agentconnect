import { describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_MCP_SKILL_NAMES,
  builtinMcpSkills,
  stripSkillFrontmatter,
  type BuiltinMcpSkillName
} from '../src/skills/builtin-skills.js'
import {
  allowedSessionSkills,
  buildReadSkillTool,
  INLINE_SUMMARY_CHAR_BUDGET,
  normalizeSkillReferencePath,
  readSkill,
  replaceReadSkillTool,
  resolveSessionBuiltinSkills,
  systemSkillsInstructions
} from '../src/mcp/ops/skill-guide.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import { ALL_TOOL_NAMES } from '../src/mcp/tools.js'
import { obj, type ToolDescriptor } from '../src/tool-schema/descriptor.js'

const SOURCE_ROOT = fileURLToPath(new URL('../builtin-skills', import.meta.url))
const ALL = [...BUILTIN_MCP_SKILL_NAMES]

function ctx(skills: readonly BuiltinMcpSkillName[], extra: Partial<SessionContext> = {}): SessionContext {
  return {
    agentId: 'a1',
    platform: 'webchat',
    isDm: false,
    channel: 'c1',
    thread: 't1',
    deliveryThread: 't1',
    tools: [buildReadSkillTool(skills)],
    builtinSkills: skills,
    ...extra
  }
}

const read = (session: SessionContext, args: Record<string, unknown>) =>
  readSkill(session, args, {}) as Promise<{ skill: string; path: string; references?: string[]; content: string }>

describe('builtin MCP skill bundle', () => {
  it('loads every packaged SKILL.md and reference file, frontmatter stripped', async () => {
    const bundles = await builtinMcpSkills()
    expect([...bundles.keys()]).toEqual(ALL)
    const onDisk = readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => relative(SOURCE_ROOT, join(entry.parentPath, entry.name)).replace(/\\/g, '/'))
      .sort()
    const loaded = [...bundles.values()]
      .flatMap((bundle) => [
        `${bundle.name}/SKILL.md`,
        ...[...bundle.references.keys()].map((p) => `${bundle.name}/${p}`)
      ])
      .sort()
    expect(loaded).toEqual(onDisk)
    expect(loaded).toHaveLength(16)
    for (const bundle of bundles.values()) expect(bundle.body.startsWith('---')).toBe(false)
  })

  it('cites only reference files that exist in the bundle', async () => {
    const bundles = await builtinMcpSkills()
    for (const bundle of bundles.values()) {
      for (const [, cited] of bundle.body.matchAll(/\]\((references\/[A-Za-z0-9/_-]+\.md)\)/g))
        expect(bundle.references.has(cited!), `${bundle.name} cites ${cited}`).toBe(true)
      for (const text of [bundle.body, ...bundle.references.values()]) {
        for (const [, skill, cited] of text.matchAll(/(agentconnect-[a-z-]+)\/(references\/[A-Za-z0-9/_-]+\.md)/g))
          expect(bundles.get(skill as BuiltinMcpSkillName)?.references.has(cited!), `${skill}/${cited}`).toBe(true)
      }
    }
  })

  it('strips only a leading YAML block', () => {
    expect(stripSkillFrontmatter('---\nname: x\n---\n\n# Body\n')).toBe('# Body\n')
    expect(stripSkillFrontmatter('# Body\n---\nx\n---\n')).toBe('# Body\n---\nx\n---\n')
  })
})

describe('readSkill descriptor', () => {
  it('fits the Codex ceiling with every skill, and lists exactly the session skills', () => {
    const all = buildReadSkillTool(ALL)
    expect(all.description.length).toBeLessThanOrEqual(INLINE_SUMMARY_CHAR_BUDGET)
    for (const name of ALL) expect(all.description).toContain(`- ${name}:`)
    const two = buildReadSkillTool(['agentconnect-images', 'agentconnect-platform'])
    expect(two.description).not.toContain('agentconnect-create-agent')
    expect((two.inputSchema.properties as Record<string, { enum?: string[] }>).name!.enum).toEqual([
      'agentconnect-images',
      'agentconnect-platform'
    ])
    expect(two.inputSchema.required).toEqual(['name'])
    expect(systemSkillsInstructions(ALL)).toBeUndefined()
  })

  it('is auto-allowed by name', () => {
    expect(ALL_TOOL_NAMES).toContain('readSkill')
  })
})

describe('resolveSessionBuiltinSkills', () => {
  const share: ToolDescriptor = { name: 'shareFile', description: '', inputSchema: obj({}) }

  it('scopes skills to the session capabilities', () => {
    expect(resolveSessionBuiltinSkills({ tools: [share], hasAdminMcp: true, restricted: false })).toEqual(ALL)
    expect(resolveSessionBuiltinSkills({ tools: [share], hasAdminMcp: false, restricted: false })).toEqual([
      'agentconnect-images',
      'agentconnect-platform'
    ])
    expect(resolveSessionBuiltinSkills({ tools: [], hasAdminMcp: false, restricted: false })).toEqual([
      'agentconnect-platform'
    ])
    expect(resolveSessionBuiltinSkills({ tools: [share], hasAdminMcp: true, restricted: true })).toEqual([])
  })

  it('downgrades a registered descriptor in place when admin MCP falls back', () => {
    const tools = [share, buildReadSkillTool(ALL)]
    const session = ctx(ALL, { tools })
    const downgraded = resolveSessionBuiltinSkills({ tools, hasAdminMcp: false, restricted: false })
    replaceReadSkillTool(tools, downgraded)
    session.builtinSkills = downgraded
    expect(tools[1]!.description).not.toContain('agentconnect-create-team')
    expect(allowedSessionSkills(session)).toEqual(['agentconnect-images', 'agentconnect-platform'])
    // Without a recorded set, the advertised enum is the allowlist.
    expect(allowedSessionSkills({ tools })).toEqual(['agentconnect-images', 'agentconnect-platform'])
  })
})

describe('readSkill', () => {
  it('reads SKILL.md with the MCP banner and the reference manifest', async () => {
    for (const path of [undefined, '', 'SKILL.md', './skill.md']) {
      const result = await read(ctx(ALL), { name: 'agentconnect-platform', ...(path === undefined ? {} : { path }) })
      expect(result.path).toBe('SKILL.md')
      expect(result.references).toEqual(['references/admin-operations.md', 'references/platform-guide.md'])
      expect(result.content).toMatch(/^> \[MCP System Skill: agentconnect-platform\]/)
      expect(result.content).toContain('# AgentConnect Platform')
      expect(result.content).toContain('## Bundled reference files in `agentconnect-platform`')
      expect(result.content).not.toMatch(/^name: agentconnect-platform$/m)
    }
  })

  it('reads a reference file, tolerating a missing references/ prefix and cross-skill paths', async () => {
    const guide = await read(ctx(ALL), { name: 'agentconnect-platform', path: 'references/platform-guide.md' })
    expect(guide.path).toBe('references/platform-guide.md')
    expect(guide.content).toMatch(/^> \[MCP System Skill: agentconnect-platform — references\/platform-guide.md\]/)
    expect((await read(ctx(ALL), { name: 'agentconnect-create-agent', path: 'templates/qa.md' })).path).toBe(
      'references/templates/qa.md'
    )
    const routed = await read(ctx(ALL), {
      name: 'agentconnect-create-team',
      path: '../../../agentconnect-create-agent/references/code-hosts.md'
    })
    expect(routed).toMatchObject({ skill: 'agentconnect-create-agent', path: 'references/code-hosts.md' })
  })

  it('refuses unknown paths, traversal and skills this session does not offer, naming the choices', async () => {
    await expect(read(ctx(ALL), { name: 'agentconnect-platform', path: 'references/wrong.md' })).rejects.toThrow(
      /Available reference paths: "references\/admin-operations.md", "references\/platform-guide.md"/
    )
    await expect(read(ctx(ALL), { name: 'agentconnect-platform', path: '../../etc/passwd' })).rejects.toThrow(
      /unknown reference path/
    )
    await expect(read(ctx(ALL), { name: 'agentconnect-images', path: 'references/x.md' })).rejects.toThrow(
      /has no bundled reference files/
    )
    const slack = ctx(['agentconnect-images', 'agentconnect-platform'])
    await expect(read(slack, { name: 'agentconnect-create-agent' })).rejects.toThrow(
      /not available in this session; available skills: agentconnect-images, agentconnect-platform/
    )
    // A cross-skill path cannot reach a skill the session lacks.
    await expect(
      read(slack, { name: 'agentconnect-platform', path: 'agentconnect-create-agent/references/code-hosts.md' })
    ).rejects.toThrow(/unknown reference path/)
    await expect(read(ctx(ALL), { name: 'my-org-skill' })).rejects.toThrow(/listOrgSkills/)
  })

  it('dispatches through executeTool with a self-correcting rejection', async () => {
    const debug = vi.fn()
    const deps = { log: { debug } } as unknown as OpsDeps
    const session = ctx(['agentconnect-platform'])
    const ok = (await executeTool(session, 'readSkill', { name: 'agentconnect-platform' }, deps)) as { skill: string }
    expect(ok.skill).toBe('agentconnect-platform')
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('readSkill agent=a1 platform=webchat'))
    await expect(executeTool(session, 'readSkill', { name: 'agentconnect-images' }, deps)).rejects.toThrow(/readSkill/)
  })

  it('normalizes without a bundle hit by leaving the path for the lookup to refuse', async () => {
    const bundles = await builtinMcpSkills()
    expect(
      normalizeSkillReferencePath('agentconnect-platform', '\\references\\platform-guide.md', ALL, bundles)
    ).toEqual({ skill: 'agentconnect-platform', path: 'references/platform-guide.md' })
  })
})
