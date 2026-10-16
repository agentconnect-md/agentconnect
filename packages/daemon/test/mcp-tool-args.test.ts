import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SEND_MESSAGE_ACTION_SCHEMAS, TOOL_ARG_SCHEMAS } from '../src/mcp/ops.js'
import { CODE_HOST_EFFECT_TOOLS, GITHUB_REVIEW_TOOLS, toolsForIntegrations } from '../src/mcp/tools.js'
import { externalMemoryTools } from '../src/memory/tools.js'
import { FOLLOW_UP_TOOL, PROPOSE_TOOL, RECORD_CHECK_TOOL } from '../src/mcp/ops/assistant-items.js'
import { ASSISTANT_REMINDER_TOOLS } from '../src/mcp/ops/assistant-reminders.js'
import { LIST_TASKS_TOOL, STOP_TASK_TOOL } from '../src/mcp/ops/assistant-subsessions.js'
import { FIRST_LOOK_TOOL } from '../src/mcp/ops/first-look.js'
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
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: 'xoxb', appToken: 'xapp' }
}
const telegramInt: Integration = {
  id: 'int-2',
  platform: 'telegram',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { botToken: '123456:ABC' }
}
const qqInt: Integration = {
  id: 'int-3',
  platform: 'qq',
  core: {
    mode: 'direct',
    bindRules: [],
    mutedChannels: [],
    gated: false,
    sessionModes: [],
    decisions: { bindings: [], definitions: [] }
  },
  config: { appId: '123456', appSecret: 'secret' }
}

const ALL_CAPABILITIES = new Set(['recall', 'create', 'get', 'update', 'delete'] as const)

// Port gates open per SESSION platform, so one platform's tool list is not the whole surface:
// a tool only Telegram declares is advertised only to a Telegram session.
const advertised: ToolDescriptor[] = [
  ...toolsForIntegrations([slackInt, telegramInt, qqInt], {
    organizationKnowledge: true,
    decisions: true,
    currentPlatform: 'slack'
  }),
  ...toolsForIntegrations([slackInt, telegramInt], {
    organizationKnowledge: true,
    decisions: true,
    currentPlatform: 'telegram'
  }),
  ...externalMemoryTools(ALL_CAPABILITIES),
  ...GITHUB_REVIEW_TOOLS,
  ...CODE_HOST_EFFECT_TOOLS,
  FOLLOW_UP_TOOL,
  FIRST_LOOK_TOOL,
  RECORD_CHECK_TOOL,
  PROPOSE_TOOL,
  ...ASSISTANT_REMINDER_TOOLS,
  LIST_TASKS_TOOL,
  STOP_TASK_TOOL
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
      // `listChannelAgents` and `submitGithubReview` are dispatch-only aliases.
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

  it.each(Object.entries(SEND_MESSAGE_ACTION_SCHEMAS))(
    'sendMessage %s takes only advertised arguments',
    (_, schema) => {
      const root = fields(byName.get('sendMessage')!.inputSchema as ObjectSchemaView)
      const action = validatorFields(schema)
      expect(action.properties.filter((key) => !root.properties.includes(key))).toEqual([])
      expect(action.required).toEqual(expect.arrayContaining(root.required))
    }
  )

  it('advertises every sendMessage action argument, and requires only action and message', () => {
    const root = fields(byName.get('sendMessage')!.inputSchema as ObjectSchemaView)
    const union = new Set(
      Object.values(SEND_MESSAGE_ACTION_SCHEMAS).flatMap((schema) => validatorFields(schema).properties)
    )
    expect(root.properties).toEqual([...union].sort())
    expect(root.required).toEqual(['action', 'message'])
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
