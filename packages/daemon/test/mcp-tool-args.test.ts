import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SEND_MESSAGE_BRANCHES, TOOL_ARG_SCHEMAS } from '../src/mcp/ops.js'
import {
  CODE_HOST_EFFECT_TOOLS,
  GITHUB_REVIEW_TOOLS,
  RETIRED_ORCHESTRATION_TOOLS,
  toolsForIntegrations
} from '../src/mcp/tools.js'
import { externalMemoryTools } from '../src/memory/tools.js'
import { allPortPlatforms, sessionToolsFor } from '../src/platforms/read-ports.js'
import type { ToolDescriptor } from '../src/tool-schema/descriptor.js'
import type { Integration } from '../src/agents/agent-schema.js'

/**
 * The advertised JSON Schema and the zod validator are two views of ONE tool contract: the
 * descriptor carries the model-facing prose and the narrowed platform enums, the zod schema
 * is what the dispatch boundary actually enforces. Nothing derives one from the other, so
 * this is what keeps them from drifting — a field added to only one side fails here.
 */
const slackInt: Integration = {
  id: 'int-1',
  platform: 'slack',
  core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
  config: { botToken: 'xoxb', appToken: 'xapp' }
}
const telegramInt: Integration = {
  id: 'int-2',
  platform: 'telegram',
  core: { mode: 'direct', bindRules: [], mutedChannels: [], gated: false },
  config: { botToken: '123456:ABC' }
}

const ALL_CAPABILITIES = new Set(['recall', 'create', 'get', 'update', 'delete'] as const)

const advertised: ToolDescriptor[] = [
  ...toolsForIntegrations([slackInt, telegramInt], {
    organizationKnowledge: true,
    currentPlatform: 'slack'
  }),
  ...externalMemoryTools(ALL_CAPABILITIES),
  ...RETIRED_ORCHESTRATION_TOOLS,
  ...GITHUB_REVIEW_TOOLS,
  ...CODE_HOST_EFFECT_TOOLS
]

interface ObjectSchemaView {
  properties?: Record<string, unknown>
  required?: string[]
  oneOf?: ObjectSchemaView[]
}

const fields = (schema: ObjectSchemaView) => ({
  properties: Object.keys(schema.properties ?? {}).sort(),
  required: [...(schema.required ?? [])].sort()
})

/** The validator's own field view, through zod's JSON Schema projection. */
const validatorFields = (schema: z.ZodType) =>
  fields(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as ObjectSchemaView)

describe('advertised tool schemas agree with their zod validators', () => {
  const byName = new Map(advertised.map((tool) => [tool.name, tool]))

  it('advertises every dispatchable tool that takes arguments', () => {
    const missing = [...TOOL_ARG_SCHEMAS.keys()].filter(
      // `listChannelAgents` and `submitGithubReview` are dispatch-only aliases, and the orchestration triple is retired.
      (name) => !byName.has(name) && name !== 'listChannelAgents' && name !== 'submitGithubReview'
    )
    expect(missing).toEqual([])
  })

  it.each([...TOOL_ARG_SCHEMAS.keys()].filter((name) => name !== 'listChannelAgents' && name !== 'submitGithubReview'))(
    '%s takes exactly the advertised arguments',
    (name) => {
      const descriptor = byName.get(name)!
      const schema = TOOL_ARG_SCHEMAS.get(name)!
      expect(validatorFields(schema)).toEqual(fields(descriptor.inputSchema as ObjectSchemaView))
    }
  )

  it.each(Object.entries(SEND_MESSAGE_BRANCHES))('sendMessage %s branch matches its oneOf branch', (target, schema) => {
    const root = byName.get('sendMessage')!.inputSchema as ObjectSchemaView
    const branch = root.oneOf!.find((candidate) => candidate.required?.includes(target))!
    expect(validatorFields(schema)).toEqual(fields(branch))
  })
})

describe('platform session tools advertise exactly what their validators take', () => {
  for (const platform of allPortPlatforms()) {
    const family = sessionToolsFor(platform)
    if (!family) continue
    it.each(family.descriptors.map((d) => d.name))(`${platform}: %s`, (name) => {
      const descriptor = family.descriptors.find((d) => d.name === name)!
      const schema = family.argSchemas.get(name)
      expect(schema, `${name} has no validator`).toBeDefined()
      expect(validatorFields(schema!)).toEqual(fields(descriptor.inputSchema as ObjectSchemaView))
    })
  }
})
