// Every tool the daemon offers must reach the model whole on both runtimes it ships (Claude Code and Codex).
import { describe, expect, it } from 'vitest'
import { MemoryPluginOperation } from '@agentconnect.md/protocol'
import {
  ALL_TOOL_NAMES,
  CODE_HOST_EFFECT_TOOLS,
  DECISION_TOOLS,
  GITHUB_REVIEW_TOOLS,
  KNOWLEDGE_TOOLS,
  toolsForIntegrations
} from '../src/mcp/tools.js'
import { ASSISTANT_ITEM_TOOLS, PATROL_UPDATE_ITEM_TOOL, PROPOSE_TOOL } from '../src/mcp/ops/assistant-items.js'
import { ASSISTANT_REMINDER_TOOLS, REMINDER_TOOLS } from '../src/mcp/ops/assistant-reminders.js'
import { STOP_SUBSESSION_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { externalMemoryTools } from '../src/memory/tools.js'
import { allAttachmentReadTools, allPortPlatforms, allSessionToolDescriptors } from '../src/platforms/read-ports.js'
import type { Integration } from '../src/agents/agent-schema.js'
import type { ToolDescriptor } from '../src/tool-schema/descriptor.js'

// Claude Code 2.1.293 cuts an MCP tool description at CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, default 2048, and appends "… [truncated]".
const CLAUDE_CODE_MAX_DESCRIPTION_CHARS = 2048
// Codex 0.160.1 strips every description from an MCP input schema over 5,000 bytes (codex-rs/tools/src/json_schema/compaction.rs).
const CODEX_MAX_INPUT_SCHEMA_BYTES = 5000
// Names the daemon dispatches without ever offering a descriptor.
const DESCRIPTORLESS = new Set(['submitGithubReview'])

const COMBINATORS = ['allOf', 'anyOf', 'oneOf'] as const
type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
const mapValues = (v: Node, f: (x: unknown) => unknown): Node =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, f(x)]))

/** Claude Code flattens a top-level combinator and prepends this note to the description before cutting it. */
function claudeCodeDescription(tool: ToolDescriptor): string {
  const schema = tool.inputSchema as Node
  const present = COMBINATORS.filter((k) => k in schema)
  if (present.length === 0) return tool.description
  if (!present.includes('anyOf') && !present.includes('oneOf'))
    return `Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).\n${tool.description}`
  const key = present.includes('oneOf') ? 'oneOf' : 'anyOf'
  const lead = key === 'oneOf' ? 'Provide parameters for exactly one of' : 'Provide parameters for at least one of'
  const groups = (schema[key] as Node[]).map((b) =>
    Array.isArray(b.required) && b.required.length > 0
      ? b.required.join(', ')
      : Object.keys(isNode(b.properties) ? b.properties : {}).join(', ')
  )
  return `Input constraint: ${lead}: ${groups.map((g) => `(${g})`).join(' or ')}.\n${tool.description}`
}

/** Codex's `sanitize_json_schema`, reduced to what changes the serialized size. */
function codexSanitize(v: unknown): unknown {
  if (typeof v === 'boolean') return { type: 'string' }
  if (Array.isArray(v)) return v.map(codexSanitize)
  if (!isNode(v)) return v
  const m: Node = { ...v }
  if (isNode(m.properties)) m.properties = mapValues(m.properties, codexSanitize)
  if ('items' in m) m.items = codexSanitize(m.items)
  if (isNode(m.additionalProperties)) m.additionalProperties = codexSanitize(m.additionalProperties)
  for (const k of COMBINATORS) if (k in m) m[k] = codexSanitize(m[k])
  for (const k of ['$defs', 'definitions']) if (isNode(m[k])) m[k] = mapValues(m[k], codexSanitize)
  if ('const' in m) {
    m.enum = [m.const]
    delete m.const
  }
  let types = typeof m.type === 'string' ? [m.type] : Array.isArray(m.type) ? (m.type as string[]) : []
  if (types.length === 0 && ('$ref' in m || COMBINATORS.some((k) => k in m))) return m
  if (types.length === 0) {
    if ('properties' in m || 'required' in m || 'additionalProperties' in m) types = ['object']
    else if ('items' in m || 'prefixItems' in m) types = ['array']
    else if ('enum' in m || 'format' in m) types = ['string']
    else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].some((k) => k in m))
      types = ['number']
    else return {}
  }
  m.type = types.length === 1 ? types[0] : types
  if (types.includes('object') && !('properties' in m)) m.properties = {}
  if (types.includes('array') && !('items' in m)) m.items = { type: 'string' }
  return m
}

/** The fields Codex's `JsonSchema` serializes; `title`, `minLength`, `pattern` and the rest are dropped. */
function codexProject(v: unknown): Node {
  if (!isNode(v)) return {}
  const out: Node = {}
  for (const k of ['$ref', 'type', 'description', 'enum', 'minItems', 'required']) if (k in v) out[k] = v[k]
  if ('items' in v) out.items = codexProject(v.items)
  if (isNode(v.properties)) out.properties = mapValues(v.properties, codexProject)
  if ('additionalProperties' in v)
    out.additionalProperties =
      typeof v.additionalProperties === 'boolean' ? v.additionalProperties : codexProject(v.additionalProperties)
  for (const k of COMBINATORS) if (Array.isArray(v[k])) out[k] = (v[k] as unknown[]).map(codexProject)
  for (const k of ['$defs', 'definitions']) if (isNode(v[k])) out[k] = mapValues(v[k], codexProject)
  return out
}

/** Compact UTF-8 size Codex measures an input schema at, after it adds a missing root `properties`. */
function codexInputSchemaBytes(tool: ToolDescriptor): number {
  const root: Node = { ...tool.inputSchema }
  if (root.properties == null) root.properties = {}
  return Buffer.byteLength(JSON.stringify(codexProject(codexSanitize(root))), 'utf8')
}

/** Every descriptor a session can carry, across the platform sets and modes that change one. */
function offeredTools(): ToolDescriptor[] {
  const platforms = allPortPlatforms()
  const tools: ToolDescriptor[] = []
  for (const combo of [[], ...platforms.map((p) => [p]), platforms]) {
    const integrations = combo.map((platform) => ({ platform }) as Integration)
    for (const currentPlatform of [undefined, 'webchat', ...combo])
      tools.push(
        ...toolsForIntegrations(integrations, {
          organizationKnowledge: true,
          decisions: true,
          currentPlatform,
          consoleImages: true
        })
      )
  }
  return [
    ...tools,
    ...KNOWLEDGE_TOOLS,
    ...DECISION_TOOLS,
    ...GITHUB_REVIEW_TOOLS,
    ...CODE_HOST_EFFECT_TOOLS,
    ...ASSISTANT_ITEM_TOOLS,
    PROPOSE_TOOL,
    PATROL_UPDATE_ITEM_TOOL,
    ...ASSISTANT_REMINDER_TOOLS,
    ...REMINDER_TOOLS,
    STOP_SUBSESSION_TOOL,
    ...externalMemoryTools(new Set(MemoryPluginOperation.options)),
    ...allAttachmentReadTools(),
    ...allSessionToolDescriptors()
  ]
}

/** Each tool's largest measure across every variant built, as `name: size` for the ones over `limit`. */
function over(measure: (tool: ToolDescriptor) => number, limit: number): string[] {
  const worst = new Map<string, number>()
  for (const tool of offeredTools()) worst.set(tool.name, Math.max(worst.get(tool.name) ?? 0, measure(tool)))
  return [...worst].filter(([, size]) => size > limit).map(([name, size]) => `${name}: ${size} > ${limit}`)
}

describe('tool descriptions fit the runtimes', () => {
  it('measures every tool the daemon can offer', () => {
    const built = new Set(offeredTools().map((tool) => tool.name))
    expect(ALL_TOOL_NAMES.filter((name) => !built.has(name) && !DESCRIPTORLESS.has(name))).toEqual([])
  })

  it('keeps each description within the Claude Code cut, including its schema note', () => {
    expect(over((tool) => claudeCodeDescription(tool).length, CLAUDE_CODE_MAX_DESCRIPTION_CHARS)).toEqual([])
  })

  it('keeps each input schema small enough that Codex keeps its parameter descriptions', () => {
    expect(over(codexInputSchemaBytes, CODEX_MAX_INPUT_SCHEMA_BYTES)).toEqual([])
  })
})
